# LINE Bot 實戰（上）：用 Vertex AI Google Maps Grounding，讓使用者傳定位就能找到附近咖啡廳

大家哈囉！今天想分享一個我自己非常喜歡的 LINE Bot 實戰：

**使用者只要在 LINE 裡傳送目前位置，Bot 就會透過 Vertex AI 的 Google Maps Grounding，找出附近 3～5 間咖啡廳，整理成繁體中文推薦，最後附上可以直接打開的 Google Maps 來源卡片。**

這個需求聽起來很簡單：

> 丟位置給 Bot，Bot 幫我找附近咖啡廳。

但真正做下去後，我才發現它一次串起了幾個很有意思的技術問題：

- LINE 原生位置訊息（Location Message）
- Vertex AI 與 Google Maps Grounding
- 經緯度如何傳給模型
- 英文 Grounding 與繁體中文回答
- Google Maps 來源 attribution
- 店家頁與評論頁的資料去重

這一篇先聚焦在產品與 Grounding 本身：如何讓一個位置真的變成一份有來源、可以點開、看得懂的咖啡廳推薦。

至於 ADC、IAM、Cloud Run，以及最戲劇性的「Webhook 明明 200，LINE 卻完全沒反應」，我會放在下篇完整記錄。

---

## ☕ 我想做的互動流程其實很簡單

一開始，我先把使用者體驗定得非常清楚：

1. 使用者傳送「開始」或任意文字。
2. Bot 顯示 LINE 原生的「傳送目前位置」Quick Reply。
3. 使用者分享目前位置。
4. 後端取得 latitude 與 longitude。
5. Vertex AI 透過 Google Maps Grounding 搜尋附近咖啡廳。
6. 系統將英文 Grounded response 翻成台灣繁體中文。
7. Bot 回傳推薦摘要，以及每個 Google Maps 來源的 Flex Message 卡片。

這個流程最重要的設計原則是：

**使用者不需要手打地址，也不需要離開 LINE 去搜尋。**

位置輸入直接使用 LINE 原生的 `location` action：

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

使用者點下按鈕後，LINE 會直接開啟地圖介面。送出的位置會進入 webhook，後端可以取得乾淨的經緯度，不需要自己解析格式不固定的地址文字。

這跟我之前做 Datetime Picker、Camera Action 時的體會很像：

**只要 LINE 已經有原生輸入元件，就應該盡量讓使用者用點的，不要叫使用者自己打。**

---

## 🗺️ 這次不是只問 Gemini，而是讓答案真的 Grounding 在 Google Maps 上

一般 LLM 很會回答「附近有什麼咖啡廳」，但如果沒有即時地圖資料，它可能只是使用模型記憶，甚至產生已歇業、位置錯誤或不存在的店家。

所以這次的重點不是單純呼叫 Gemini，而是啟用 **Google Maps Grounding**。

我們最後採用 Vertex AI / Gemini Enterprise Agent Platform 的方式進入，不使用 `GEMINI_API_KEY`，而是透過 Google Cloud 身分進行認證。

初始化方式如下：

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  enterprise: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
  apiVersion: 'v1'
});
```

真正查詢咖啡廳時，Google Maps tool 與使用者位置會放在 `generateContent` 設定中：

```typescript
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [
    'Find 3 to 5 good cafes near the supplied user location.',
    'Prioritize places that are practical for sitting down with a laptop.',
    'Do not invent outlet, Wi-Fi, time-limit, or noise information when unavailable.',
    'Keep the full answer concise and respond in English.'
  ].join(' '),
  config: {
    tools: [{ googleMaps: {} }],
    toolConfig: {
      retrievalConfig: {
        latLng: { latitude, longitude },
        languageCode: 'en_US'
      }
    }
  }
});
```

這裡最重要的不是 prompt 寫得多華麗，而是我們明確要求模型：

- 只推薦 3～5 間，避免 LINE 訊息太長
- 優先考慮適合坐下來或使用筆電的店
- 沒有資料就不要亂說有插座、Wi-Fi 或不限時
- 回答必須建立在 Grounding 資料上

尤其是「沒有資料就不要亂說」非常重要。

插座、安靜程度、不限時這些資訊，不一定會出現在每間店的 Google Maps 資料裡。如果為了讓推薦看起來完整，硬叫 AI 每間都寫，反而很容易把不確定的資訊講得像真的。

---

## 🌏 為什麼要做「英文 Grounding、繁中轉譯」兩階段？

參考 Google Maps Grounding 文件時，我們確認到目前 Grounded prompt 與 response 需要使用英文。

但我的 LINE Bot 使用者當然希望看到繁體中文。

所以最後的架構不是硬要求 Grounding 直接回中文，而是拆成兩個階段：

```text
LINE 經緯度
    ↓
Vertex AI + Google Maps Grounding
    ↓
英文 Grounded recommendation + Google Maps metadata
    ↓
同一個 Vertex AI client 進行繁中轉譯
    ↓
繁中摘要 + 原始 Google Maps 來源卡片
```

第二次模型呼叫只做翻譯，而且限制非常清楚：

- 保留店名、數字與所有事實
- 不新增原回答沒有的資訊
- 不自己產生 URL
- 只輸出翻譯後的推薦內容

Google Maps URL 完全不經過翻譯模型，而是直接從 `groundingMetadata.groundingChunks` 取出。

這樣可以避免一個很危險的情況：

**中文翻得很好，但網址是模型自己生的。**

回答內容可以整理，來源連結不能猜。

---

## 🔗 不只顯示答案，也要把 Google Maps 來源完整呈現

Google Maps Grounding 的回應不只包含文字，也會附上實際使用過的 Maps chunks。

我們從以下欄位取得店家名稱與網址：

```typescript
const chunks = candidate.groundingMetadata?.groundingChunks ?? [];

for (const chunk of chunks) {
  const maps = chunk.maps;

  if (maps?.title && maps?.uri) {
    // 建立 Google Maps 來源卡片
  }
}
```

最後在 LINE 中，我沒有只丟一長串純文字，而是將來源做成 Flex Message carousel：

- 顯示咖啡廳名稱
- 標示「資料來源：Google Maps」
- 提供「在 Google Maps 查看」按鈕
- 使用者可以直接查看營業時間、照片、評論與導航

這個設計不只比較漂亮，也讓 AI 推薦變得可以驗證。

使用者不是只能相信 Bot，而是能直接點回資料來源確認。

---

## 🧩 實測後才發現：5 個 Maps 來源，不代表是 5 間不同咖啡廳

第一次 Maps Grounding 實測成功時，我們真的拿到了 5 個 sources。

但仔細看標題，卻發現裡面同時包含：

- 店家的 Google Maps 頁面
- 同一間店的 Review 頁面
- 同一地點不同評論來源

如果直接全部做成 Flex Message，使用者會看到好幾張幾乎一樣的卡片，還以為 Bot 只會推薦同一間店。

所以不能只用 URL 去重，因為店家頁與評論頁本來就是不同 URL。

最後的做法是：

1. 優先使用 `placeId` 當唯一識別。
2. 沒有 `placeId` 時，再用正規化後的店名去重。
3. 移除標題中的 `Review of` 與 `- Google Maps`。
4. 同一地點同時有店家頁與評論頁時，優先保留店家頁。

核心概念如下：

```typescript
const key = maps.placeId || normalizedTitle || maps.uri;

if (!existing || (existing.isReview && !isReview)) {
  uniqueSources.set(key, {
    title: normalizedTitle,
    uri: maps.uri,
    isReview
  });
}
```

這是一個很典型的 Grounding 實戰問題：

**資料有回來，不代表資料已經適合直接顯示。**

AI integration 後面通常還需要一層產品化整理，才能真正成為好用的介面。

---

## 🏆 上篇實戰總結

到這裡，我們已經完成一條完整的 location-aware recommendation pipeline：

- LINE 原生 Location Action 接收乾淨經緯度
- Vertex AI Google Maps Grounding 搜尋附近咖啡廳
- 英文 Grounding、繁體中文轉譯
- Google Maps 來源不經模型改寫
- Flex Message 呈現店家與來源按鈕
- 使用 `placeId` 合併店家頁與評論頁

但程式在本機成功，只代表產品完成一半。

真正部署到 Google Cloud 後，我們接著遇到了：登入成功卻沒有權限、quota project 設定失敗、Cloud Run runtime 身分，以及最讓人困惑的「Webhook 200 OK，但使用者傳位置後完全沒反應」。

這些問題，我會在下篇完整拆解。

👉 **下篇：LINE Bot 實戰（下）——從 ADC、IAM 到 Cloud Run，解決 Webhook 200 卻完全沒回覆的問題**

---

### 📂 專案開源與完整程式碼

本次完整程式碼已整理在 GitHub：

👉 **GitHub 儲存庫：[https://github.com/zonawang/line-map-grounding](https://github.com/zonawang/line-map-grounding)**

👉 **更多過往 AI × LINE Bot 實作：[https://github.com/zonawang/zona-ai-learning-lab](https://github.com/zonawang/zona-ai-learning-lab)**
