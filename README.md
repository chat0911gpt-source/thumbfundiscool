# 母子基金回測 Dashboard：GitHub Pages 版

這一版是純靜態網站，可以放在 GitHub Pages 長期免費使用。使用者打開網站時，不會連到你的本機，也不會使用 Codex token。

## 你要上傳哪些檔案

把這個資料夾裡面的所有內容上傳到 GitHub repo 的根目錄：

- `index.html`
- `assets/`
- `data/`
- `scripts/`
- `.github/`
- `.nojekyll`
- `README.md`

不要只上傳 zip 檔，要上傳 zip 解壓縮後的內容。

## 第一次啟用 GitHub Pages

1. 進 GitHub repo。
2. 點上方 `Settings`。
3. 左邊點 `Pages`。
4. `Build and deployment` 選 `Deploy from a branch`。
5. Branch 選 `main`，資料夾選 `/ (root)`。
6. 按 `Save`。
7. 等 GitHub 顯示網址，通常會像：

```text
https://你的帳號.github.io/你的repo名稱/
```

## 第一次更新基金資料

剛上傳時 `data/` 只有空殼，請先手動跑一次資料更新：

1. 進 GitHub repo。
2. 點上方 `Actions`。
3. 點左邊 `Update fund data`。
4. 點 `Run workflow`。
5. 再按一次綠色 `Run workflow`。
6. 等它跑完，大約數分鐘。

完成後它會自動更新 `data/catalog.json` 和 `data/funds/` 裡面的基金淨值資料。

## 之後資料怎麼更新

GitHub Actions 會每天自動更新三次：

- 台灣時間 08:30
- 台灣時間 13:30
- 台灣時間 20:30

基金淨值通常每日更新，所以這樣就足夠。網站上方會顯示資料更新時間與最新淨值日期。

## 密碼

密碼是：

```text
BLK168
```

這是 GitHub Pages 靜態版，所以密碼只是簡單入口提示，不是強安全保護。懂技術的人仍然可以看原始碼。

## 免費與安全重點

- GitHub Pages 不會使用你的 Codex token。
- GitHub Pages 不會連到你的本機資料。
- 回測計算在使用者自己的瀏覽器執行。
- 基金資料由 GitHub Actions 定時抓取並更新成 JSON。
- 若使用 GitHub Free，repo 建議設為 Public，GitHub Pages 才能免費使用。
