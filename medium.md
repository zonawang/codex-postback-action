# 我用 Codex 做了一個會看地圖的 LINE Bot：三篇實戰系列

原本的完整實作已重新整理成三篇可以獨立閱讀與發布的文章。

## 第一篇：LINE 定位與專案骨架

👉 [`medium-part1.md`](./medium-part1.md)

**我用 Codex 從空 Repo 做 LINE 定位 Bot：先讓 Bot 正確收到「我在哪裡」**

- 從空 GitHub repo 開始
- Codex 如何規劃 TypeScript / Express 架構
- LINE Location Action 與 Quick Reply
- Webhook、handler、message、service 分層
- 第一階段測試與部署準備

## 第二篇：Vertex Maps Grounding

👉 [`medium-part2.md`](./medium-part2.md)

**讓 LINE Bot 真的看懂附近有什麼：用 Vertex AI Google Maps Grounding 找咖啡廳**

- Codex 如何對照兩份 Google 文件
- 從 Gemini API key 改成 Vertex AI ADC
- 經緯度與 `googleMaps` tool
- 英文 Grounding、繁中轉譯
- Google Maps attribution、Flex Message 與 `placeId` 去重

## 第三篇：雲端部署與線上除錯

👉 [`medium-part3.md`](./medium-part3.md)

**明明顯示 200 OK，LINE Bot 為什麼不回話？一次真實的 Cloud Run 除錯紀錄**

- 登入成功但 Vertex AI 仍然 403
- quota project 與 Cloud Resource Manager API
- Cloud Run runtime service account
- Webhook 200 但背景 Promise 沒有可靠完成
- Loading Animation、Push Message 與 Cloud Logging
