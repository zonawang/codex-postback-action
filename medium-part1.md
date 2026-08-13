# 用 Codex 從空 Repo 做 LINE 定位 Bot：先把 Location Action 與 Webhook 骨架打通

大家哈囉！今天想記錄一個新的 LINE Bot 實戰系列。

這次我想做的是一個「附近咖啡廳助手」：

> 使用者在 LINE 傳送目前位置，Bot 根據經緯度找出附近咖啡廳，再附上可以直接打開的 Google Maps 來源。

完整功能會用到 Vertex AI Google Maps Grounding、Cloud Run、IAM 與 LINE Messaging API。

但第一篇我不急著碰模型，而是先記錄一件更重要的事：**如何和 Codex 從一個空 GitHub repo 開始，把 LINE 定位輸入與可延伸的 webhook 架構做好。**

因為如果一開始所有邏輯都塞在同一個檔案，後面加入 Grounding、翻譯、Flex Message 與雲端除錯時，專案很快就會變成一團。

---

## 🧱 我沒有先叫 Codex 生功能，而是先一起定義第一版範圍

目標 repo 一開始是空的。

我先告訴 Codex，今天不是只要一段範例，而是要一個能部署、能測試、能繼續長大的 MVP。

第一階段範圍很明確：

- Node.js + TypeScript + Express
- LINE webhook signature 驗證
- `GET /health`
- 文字訊息顯示操作引導
- LINE 原生 Location Action
- location event 交給獨立 handler
- `.env.example`、Dockerfile、README
- Cloud Run 可部署結構

Codex 沒有直接把全部功能寫進 `server.ts`，而是先參考我過往 LINE Bot 專案的拆法，再建立這個結構：

```text
src/
  app.ts
  server.ts
  handlers/
    webhookEventHandler.ts
  messages/
    cafeMessages.ts
  routes/
    webhook.ts
  services/
    lineClient.ts
  utils/
    env.ts
    logger.ts
```

這次我很喜歡 Codex 的地方，是它不只回答「可以怎麼做」，而是真的在 repo 裡建立檔案、安裝套件、跑 typecheck，再根據 SDK 型別修正實作。

對我來說，這比一次貼出幾百行 code 更接近真正的協作。

---

## 📍 為什麼位置輸入一定要用 LINE 原生 Location Action？

最直覺的做法，是請使用者打地址。

但地址可能長這樣：

- 台北市信義區市政府附近
- 101 旁邊
- 我現在這裡
- 松高路那一帶

後端不只要解析文字，還要再做 geocoding，輸入品質也很不穩定。

所以 Codex 建議直接使用 LINE 原生 `location` action：

```typescript
const locationQuickReply = {
  items: [
    {
      type: 'action',
      action: {
        type: 'location',
        label: '傳送目前位置'
      }
    }
  ]
};
```

使用者點擊後，LINE 會直接開啟地圖介面。送出時，webhook 收到的是乾淨的：

```typescript
event.message.latitude
event.message.longitude
```

這跟我之前做 Camera Action、Datetime Picker 時的心得一樣：

**LINE 已經有原生元件時，讓使用者用點的，通常比叫他自己打更可靠。**

---

## 💬 第一版互動先保持簡單

文字訊息不需要進 AI。

使用者傳送「開始」或任意文字時，Bot 只要清楚說明功能並顯示位置按鈕：

```typescript
export function createWelcomeMessage() {
  return {
    type: 'text',
    text: [
      '☕ 我可以用 Google Maps 資料幫你找附近咖啡廳。',
      '',
      '點下面按鈕傳送位置，我會推薦 3–5 間適合坐下來喝咖啡或使用筆電的店。'
    ].join('\n'),
    quickReply: locationQuickReply
  };
}
```

Codex 在這裡沒有過度設計意圖分類，也沒有急著加入資料庫。

它先把最短的使用者路徑跑通：

1. 傳送文字
2. 看見按鈕
3. 分享位置
4. webhook 正確辨識 `location` message

這個小流程其實已經驗證了 LINE channel、signature、SDK client 與事件分派。

---

## 🧩 Webhook Route 不應該知道咖啡廳怎麼找

這次架構裡，我特別希望 route 保持乾淨。

`routes/webhook.ts` 只負責：

- LINE middleware 與 signature 驗證
- 取得 events
- 呼叫 event handler
- 回傳 HTTP response

真正判斷文字或位置訊息，放在 `webhookEventHandler.ts`：

```typescript
export async function handleWebhookEvent(event: WebhookEvent) {
  if (event.type !== 'message') {
    return;
  }

  if (event.message.type === 'text') {
    await reply(event.replyToken, [createWelcomeMessage()]);
    return;
  }

  if (event.message.type === 'location') {
    // 下一篇接入 Maps Grounding
  }
}
```

Codex 在產生程式後，還繼續做兩種檢查：

```bash
npm run typecheck
npm test
```

這很重要，因為 LINE SDK 的型別、ESM 匯入與 runtime 行為，不一定只靠「看起來正確」就能確認。

Codex 不是寫完就停，而是把 server build 起來，再做 `/health` smoke test。這讓第一階段不只是 code review 上合理，而是真的可以啟動。

---

## ☁️ 從第一天就把部署條件放進設計

雖然第一篇還沒接 Vertex AI，但專案一開始就加入：

- `Dockerfile`
- `.dockerignore`
- Cloud Run 使用的 `PORT`
- 結構化 JSON logger
- 不提交 secret 的 `.gitignore`
- `/health` endpoint

這也是 Codex 協作帶來的改變。

如果我只是請它「寫一個 location handler」，可能很快就會有答案；但當我明確說最終要部署到 GitHub 與 Cloud Run，它就會從一開始把 runtime、環境變數與驗證方式一起考慮。

產品不是最後才突然需要部署。

部署限制應該從第一版架構就進來。

---

## 🏆 第一篇實戰總結

第一階段看起來還沒有 AI，但它已經完成了幾個重要里程碑：

- 從空 repo 建立 TypeScript + Express 專案
- LINE webhook signature 驗證
- 文字訊息與位置訊息分流
- 原生 Location Action 降低輸入摩擦
- route、handler、message、service 分層
- health、build、typecheck 與測試
- Docker 與 Cloud Run 部署骨架

更重要的是，我不是叫 Codex 丟一份範例給我，而是讓它直接參與：

- 讀過往 repo
- 提出架構
- 建立檔案
- 安裝依賴
- 修正型別
- 執行測試
- 把結果推到 GitHub

下一篇，我們會把 location event 的 latitude / longitude 真正交給 Vertex AI Google Maps Grounding，並處理英文回答、繁中轉譯、Google Maps attribution，以及實測後才發現的重複來源問題。

👉 **下一篇：用 Vertex AI Google Maps Grounding 找咖啡廳——從文件轉向、繁中轉譯到來源去重**

---

### 📂 專案開源與完整程式碼

👉 **GitHub：[https://github.com/zonawang/line-map-grounding](https://github.com/zonawang/line-map-grounding)**

👉 **更多 AI × LINE Bot 實作：[https://github.com/zonawang/zona-ai-learning-lab](https://github.com/zonawang/zona-ai-learning-lab)**
