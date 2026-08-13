# 我用 Codex 替 Zona Cafe 加上 Postback：四篇短篇實戰系列

今天完成的 Postback 功能整理成四篇短文，每篇只回答一個問題。

內容不重新介紹先前已寫過的 LINE 定位、Google Maps Grounding、Loading Animation、Cloud Run 或 IAM 基礎。

## 第一篇：為什麼選 Postback？

👉 [`medium-postback-part1.md`](./medium-postback-part1.md)

**LINE Bot 的「換一批」該用哪種按鈕？我請 Codex 先評估 Postback 再動手**

- URI、Location 與 Postback 的責任分工
- Postback data 的 300 字限制
- 版本、action 白名單與 session ID
- `displayText` 與後端 data 分工

## 第二篇：Session 怎麼設計？

👉 [`medium-postback-part2.md`](./medium-postback-part2.md)

**一顆「換一批」背後要記住什麼？我和 Codex 設計 Firestore 搜尋 Session**

- 為什麼不用 Cloud Run 記憶體
- 最小化 Firestore session
- 使用者與聊天室驗證
- 30 分鐘過期、TTL 與 transaction 連點鎖
- Firestore 失敗時的功能降級

## 第三篇：程式怎麼接起來？

👉 [`medium-postback-part3.md`](./medium-postback-part3.md)

**「換一批」怎麼真的換？我和 Codex 實作 LINE Postback Handler 與測試**

- Event 分流與 Postback parser
- 排除上一批店家
- 延續工作友善偏好
- Quick Reply 與分類錯誤訊息
- Protocol、訊息與 fallback 測試

## 第四篇：怎麼安全上線？

👉 [`medium-postback-part4.md`](./medium-postback-part4.md)

**不直接蓋掉舊 Bot：Codex 如何讓 LINE Webhook 成功才切換、失敗就回復**

- 新舊服務平行存在
- 新版獨立 runtime 身分
- 切換前健康檢查
- 從 LINE 讀取真正的舊 endpoint
- Verify 失敗自動回復
- TTL Processing 與功能可用性的判斷

## 專案程式碼

https://github.com/zonawang/codex-postback-action
