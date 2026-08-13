# 我用 Codex 替 Zona Cafe 加上 Postback：兩篇實戰系列

今天完成的 LINE Postback Action 功能，已整理成兩篇可以獨立閱讀與發布的文章。

這次不重複前面系列已介紹過的 LINE 定位、Google Maps Grounding、Loading Animation 與 Cloud Run 基礎，而是集中在兩個新主題：有狀態的互動設計，以及可回復的正式切換。

## 第一篇：Postback 與 Firestore Session 設計

👉 [`medium-postback-part1.md`](./medium-postback-part1.md)

**LINE Bot 的「換一批」為什麼需要資料庫？我和 Codex 從 Postback 按鈕設計到 Firestore Session**

- 為什麼「換一批」適合 Postback action
- Postback data 的 300 字限制與版本設計
- 為什麼不用 Cloud Run 記憶體保存狀態
- Firestore 短期搜尋 session
- 使用者與聊天室雙重驗證
- 30 分鐘過期、TTL 與 transaction 連點鎖
- Firestore 失敗時的漸進式降級

## 第二篇：實作、測試與安全切換

👉 [`medium-postback-part2.md`](./medium-postback-part2.md)

**從按鈕到真正上線：我和 Codex 實作 LINE Postback、Fallback 與安全切換**

- Postback event 分流與專用 handler
- 版本化 parser 與 action 白名單
- 排除上一批店家與延續工作偏好
- `displayText` 與後端 `data` 分工
- 可控制邊界的單元測試
- 新舊 Cloud Run 服務平行部署
- LINE webhook 驗證失敗自動回復
- TTL 背景建立與應用層過期判斷

## 專案程式碼

https://github.com/zonawang/codex-postback-action
