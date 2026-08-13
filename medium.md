# LINE Map Grounding Medium 系列文章

原本的完整實戰長文已重新整理成兩篇可以獨立發布的 Medium 文章。

## 上篇：產品與 Grounding 實作

👉 [`medium-part1.md`](./medium-part1.md)

**LINE Bot 實戰（上）：用 Vertex AI Google Maps Grounding，讓使用者傳定位就能找到附近咖啡廳**

內容包含：

- LINE 原生 Location Action
- Vertex AI / Gemini Enterprise client
- Google Maps Grounding 與經緯度
- 英文 Grounding、繁中轉譯
- Google Maps attribution 與 Flex Message
- 店家頁、評論頁與 `placeId` 去重

## 下篇：雲端部署與真實除錯

👉 [`medium-part2.md`](./medium-part2.md)

**LINE Bot 實戰（下）：從 ADC、IAM 到 Cloud Run，解決 Webhook 200 卻完全沒回覆的問題**

內容包含：

- Application Default Credentials
- 登入成功但沒有專案權限
- quota project 與 Cloud Resource Manager API
- Cloud Run runtime service account
- webhook response lifecycle
- Loading Animation、Push Message 與 Cloud Logging
