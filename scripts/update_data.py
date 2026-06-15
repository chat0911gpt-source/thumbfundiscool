#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import ssl
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any


BASE_URL = "https://www.blackrock.com"
PRODUCTS_URL = f"{BASE_URL}/tw/products/products-list"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
)


@dataclass(frozen=True)
class Product:
    product_id: str
    name: str
    url: str
    slug: str
    share_class: str
    currency: str
    hedged: bool
    nav: str
    nav_date: str
    inception_date: str
    ytd: str
    one_year: str
    three_year: str


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = re.sub(r"<script\b.*?</script>", "", value, flags=re.I | re.S)
    value = re.sub(r"<style\b.*?</style>", "", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def fixed_float(value: str, decimals: str | int | None = None) -> float:
    if decimals is None:
        return float(value)
    places = int(decimals)
    quant = Decimal("1") if places == 0 else Decimal("1." + ("0" * places))
    return float(Decimal(value).quantize(quant, rounding=ROUND_HALF_UP))


def class_currency_from_slug(slug: str) -> tuple[str, str, bool]:
    tokens = slug.lower().split("-")
    known_currencies = {"usd", "eur", "aud", "hkd", "gbp", "sgd", "jpy", "cad", "chf", "nzd", "rmb", "cnh"}
    currency = ""
    share_class = ""
    hedged = "hedged" in tokens
    for index, token in enumerate(tokens):
        if token in known_currencies:
            currency = token.upper()
            if index > 0 and re.fullmatch(r"[a-z][0-9]?", tokens[index - 1]):
                share_class = tokens[index - 1].upper()
    return share_class, currency, hedged


def fetch_text(url: str, allow_insecure_ssl: bool = False) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml,*/*",
            "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.6",
        },
    )
    context = ssl._create_unverified_context() if allow_insecure_ssl else None
    with urllib.request.urlopen(request, timeout=60, context=context) as response:
        return response.read().decode("utf-8", errors="ignore")


def parse_products(page: str) -> list[Product]:
    products: list[Product] = []
    rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", page, flags=re.I | re.S)
    for row in rows:
        link_match = re.search(r'<a\s+href="([^"]+)".*?>(.*?)</a>', row, flags=re.I | re.S)
        if not link_match:
            continue
        href = html.unescape(link_match.group(1))
        if "/tw/products/" not in href:
            continue
        product_id_match = re.search(r"/products/(\d+)", href)
        if not product_id_match:
            continue
        name = clean_text(link_match.group(2))
        url = urllib.parse.urljoin(BASE_URL, href)
        slug = href.rstrip("/").split("/")[-1]
        share_class, currency, hedged = class_currency_from_slug(slug)
        cells = [clean_text(cell) for cell in re.findall(r"<td\b[^>]*>(.*?)</td>", row, flags=re.I | re.S)]
        products.append(
            Product(
                product_id=product_id_match.group(1),
                name=name,
                url=url,
                slug=slug,
                share_class=share_class,
                currency=currency,
                hedged=hedged,
                nav=cells[9] if len(cells) > 9 else "",
                nav_date=cells[11] if len(cells) > 11 else "",
                inception_date=cells[12] if len(cells) > 12 else "",
                ytd=cells[0] if len(cells) > 0 else "",
                one_year=cells[3] if len(cells) > 3 else "",
                three_year=cells[5] if len(cells) > 5 else "",
            )
        )
    unique: dict[str, Product] = {}
    for product in products:
        unique[product.product_id] = product
    return sorted(unique.values(), key=lambda item: (item.name, item.share_class, item.currency, item.product_id))


def product_to_json(product: Product) -> dict[str, Any]:
    class_bits = [bit for bit in (product.share_class, product.currency, "避險" if product.hedged else "") if bit]
    class_label = " ".join(class_bits) if class_bits else f"ID {product.product_id}"
    return {
        "id": product.product_id,
        "name": product.name,
        "url": product.url,
        "slug": product.slug,
        "shareClass": product.share_class,
        "currency": product.currency,
        "hedged": product.hedged,
        "classLabel": class_label,
        "nav": product.nav,
        "navDate": product.nav_date,
        "inceptionDate": product.inception_date,
        "ytd": product.ytd,
        "oneYear": product.one_year,
        "threeYear": product.three_year,
        "display": f"{product.name}｜{class_label}｜淨值 {product.nav or '-'}｜{product.nav_date or '-'}",
    }


def extract_meta_name(page: str, source: str) -> str:
    title_match = re.search(r"<title[^>]*>(.*?)</title>", page, flags=re.I | re.S)
    title = clean_text(title_match.group(1) if title_match else "")
    return title or source


def parse_blackrock_js_array(page: str, variable_name: str) -> list[tuple[str, float]]:
    match = re.search(rf"var\s+{re.escape(variable_name)}\s*=\s*\[(.*?)\];", page, flags=re.S)
    if not match:
        return []
    body = match.group(1)
    pattern = re.compile(
        r"Date\.UTC\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)"
        r".{0,220}?y\s*:\s*Number\s*\(\(\s*([-+]?\d+(?:\.\d+)?)\s*\)"
        r"\.toFixed\(\s*(\d+)\s*\)\)",
        flags=re.S,
    )
    points: dict[str, float] = {}
    for year, zero_month, day, value, decimals in pattern.findall(body):
        date = dt.date(int(year), int(zero_month) + 1, int(day)).isoformat()
        points[date] = fixed_float(value, decimals)
    return sorted(points.items())


def load_existing_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_json(path: Path, payload: dict[str, Any]) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def build_fund_payload(product: Product, allow_insecure_ssl: bool) -> dict[str, Any]:
    page = fetch_text(product.url, allow_insecure_ssl=allow_insecure_ssl)
    series_kind = "nav"
    points = parse_blackrock_js_array(page, "navData")
    if not points:
        points = parse_blackrock_js_array(page, "performanceData")
        series_kind = "performance"
    if len(points) < 2:
        raise ValueError("沒有足夠的官網歷史淨值資料")
    return {
        "product": product_to_json(product),
        "pageName": extract_meta_name(page, product.url),
        "seriesKind": series_kind,
        "latestDate": points[-1][0],
        "pointCount": len(points),
        "points": points,
        "source": product.url,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update static BlackRock Taiwan fund data for GitHub Pages.")
    parser.add_argument("--output", default="data", help="Output data directory.")
    parser.add_argument("--mode", choices=["all", "watchlist"], default=os.environ.get("BLK_UPDATE_MODE", "all"))
    parser.add_argument("--watchlist", default="data/watchlist.json")
    parser.add_argument("--ids", default=os.environ.get("BLK_PRODUCT_IDS", ""))
    parser.add_argument("--limit", type=int, default=int(os.environ.get("BLK_UPDATE_LIMIT", "0") or 0))
    parser.add_argument("--sleep", type=float, default=float(os.environ.get("BLK_UPDATE_SLEEP", "0.15") or 0.15))
    parser.add_argument("--allow-insecure-ssl", action="store_true", default=os.environ.get("ALLOW_INSECURE_SSL", "0") == "1")
    return parser.parse_args()


def wanted_product_ids(args: argparse.Namespace) -> set[str] | None:
    if args.mode == "all" and not args.ids:
        return None
    ids = {item.strip() for item in args.ids.split(",") if item.strip()}
    watchlist_path = Path(args.watchlist)
    if args.mode == "watchlist" and watchlist_path.exists():
        payload = json.loads(watchlist_path.read_text(encoding="utf-8"))
        ids.update(str(item).strip() for item in payload.get("productIds", []) if str(item).strip())
    return ids


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output)
    funds_dir = output_dir / "funds"
    updated_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    products = parse_products(fetch_text(PRODUCTS_URL, allow_insecure_ssl=args.allow_insecure_ssl))
    if not products:
        raise SystemExit("BlackRock 台灣基金清單解析失敗")

    wanted_ids = wanted_product_ids(args)
    if wanted_ids is not None:
        products_to_fetch = [product for product in products if product.product_id in wanted_ids]
    else:
        products_to_fetch = products
    if args.limit:
        products_to_fetch = products_to_fetch[: args.limit]

    write_json(
        output_dir / "catalog.json",
        {
            "updatedAt": updated_at,
            "source": PRODUCTS_URL,
            "products": [product_to_json(product) for product in products],
        },
    )

    failures: list[dict[str, str]] = []
    fund_count = 0
    changed_count = 0
    for index, product in enumerate(products_to_fetch, start=1):
        target = funds_dir / f"{product.product_id}.json"
        try:
            payload = build_fund_payload(product, allow_insecure_ssl=args.allow_insecure_ssl)
            if write_json(target, payload):
                changed_count += 1
            fund_count += 1
            print(f"[{index}/{len(products_to_fetch)}] {product.product_id} {product.name} OK", flush=True)
        except Exception as error:
            existing = load_existing_json(target)
            if existing and existing.get("points"):
                fund_count += 1
                failures.append({"id": product.product_id, "name": product.name, "error": f"{error}；沿用既有資料"})
                print(f"[{index}/{len(products_to_fetch)}] {product.product_id} kept existing: {error}", flush=True)
            else:
                failures.append({"id": product.product_id, "name": product.name, "error": str(error)})
                print(f"[{index}/{len(products_to_fetch)}] {product.product_id} failed: {error}", flush=True)
        if args.sleep and index < len(products_to_fetch):
            time.sleep(args.sleep)

    write_json(
        output_dir / "manifest.json",
        {
            "updatedAt": updated_at,
            "source": PRODUCTS_URL,
            "productCount": len(products),
            "requestedFundCount": len(products_to_fetch),
            "fundCount": fund_count,
            "changedFundFiles": changed_count,
            "failures": failures[:80],
            "failureCount": len(failures),
        },
    )
    if fund_count == 0:
        raise SystemExit("沒有成功更新任何基金資料")


if __name__ == "__main__":
    main()
