# 讓 LINE Bot 真的看懂附近有什麼：用 Vertex AI Google Maps Grounding 找咖啡廳

上一篇，我和 Codex 從空 GitHub repo 建立了 LINE Bot 骨架，並用 Location Action 取得乾淨的 latitude 與 longitude。

這一篇終於要讓 Bot 開始「看地圖」了：

> 如何把位置交給 Vertex AI Google Maps Grounding，產生有來源的咖啡廳推薦？

這一段比我原本想像中更曲折。我們做到一半才發現 API 入口應該換成 Vertex AI；真的拿到資料後又發現：**畫面上有 5 個來源，不代表真的有 5 間不同咖啡廳。**

---

## 🧭 寫 Code 之前，Codex 先幫我確認「到底走哪一條路」

第一版原本參考 Gemini API Maps Grounding 文件，採用 API key 與 Interactions API。

後來我指定另一份 Google Cloud 文件，並明確要求：

**要走 Vertex AI，不要使用 Gemini API key。**

這不是把 `API_KEY` 那一行刪掉就結束。Codex 重新比對了整條呼叫方式：

- client 初始化方式
- `interactions.create` 與 `models.generateContent` 的差異
- Maps tool 的參數位置
- 使用者經緯度欄位
- response 裡 Grounding metadata 的格式
- Google Cloud ADC 認證方式

接著它直接查看已安裝的 `@google/genai` TypeScript declarations，確認 SDK 真正支援：

```typescript
googleMaps?: GoogleMaps;
toolConfig?: ToolConfig;
retrievalConfig?: RetrievalConfig;
groundingChunks?: GroundingChunk[];
```

這次讓我很有感：Codex 不只看網頁文件，還會回頭檢查我電腦裡真正安裝的 SDK 版本。畢竟網頁可能是最新版，但專案裡的套件不一定完全一樣。

用白話說，文件像使用說明書，TypeScript declarations 則像手上這台機器真正有哪些按鈕。兩邊都對上，寫下去才安心。

---

## 🗺️ 不帶 API Key，改拿 Google Cloud 的工作證

最後 client 改成：

```typescript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  enterprise: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
  apiVersion: 'v1'
});
```

環境變數也不再需要 `GEMINI_API_KEY`：

```env
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
GEMINI_MAPS_MODEL=gemini-2.5-flash
GEMINI_TRANSLATION_MODEL=gemini-2.5-flash
```

Codex 同步修改了：

- `.env.example`
- 環境變數驗證
- 本機 `.env`
- README 的 ADC 說明
- Cloud Run service account 部署方式
- 單元測試中的測試環境

這就是整合型修改和只改一小段 code 的差別。

如果只改 client，README 還在叫人填 API key，下一次連我自己都可能被搞混。

---

## 📍 把 LINE 給的兩個數字，交給 Google Maps

位置查詢的核心如下：

```typescript
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [
    'Find 3 to 5 good cafes near the supplied user location.',
    'Prioritize places practical for sitting down with a laptop.',
    'Do not invent outlet, Wi-Fi, time-limit, or noise information.',
    'Keep the answer concise and respond in English.'
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

程式看起來不少，但核心其實很單純：把使用者的 latitude、longitude 放進 `latLng`，再告訴模型可以使用 Google Maps。

Prompt 裡我特別保留一句：

> 沒有資料時，不要自行宣稱有插座、Wi-Fi、不限時或安靜。

這些條件很適合咖啡廳推薦，但不一定存在於每間店的 Maps 資料裡。

Codex 在這裡沒有幫我把答案硬補得很漂亮，反而替 prompt 畫了一條線。對這種有地圖資料的產品來說，少說一點，通常比很有自信地猜更好。

---

## 🌏 地圖先用英文查，最後再好好說中文

Google Maps Grounding 文件要求 Grounded prompt 與 response 使用英文，但 LINE 使用者希望看到繁體中文。

所以 Codex 沒有硬逼第一次回答直接變中文，而是設計成兩階段：

```text
LINE 經緯度
    ↓
Vertex AI + Google Maps Grounding
    ↓
英文推薦 + Grounding metadata
    ↓
同一個 Vertex AI client 翻成繁中
    ↓
繁中摘要 + 原始 Maps URLs
```

翻譯 prompt 明確限制：

- 保留店名、數字與 caveat
- 不新增事實
- 不產生 URL
- 只回傳翻譯內容

而 Google Maps URL 完全不經過第二個模型，而是直接從：

```typescript
candidate.groundingMetadata?.groundingChunks
```

取出。

Codex 也替翻譯加上備案：如果翻譯這一步失敗，至少先把原始英文回答保留下來，不要讓整個搜尋一起消失。

---

## 🔗 AI 說了什麼，使用者應該能點回去確認

每個 Maps chunk 可能包含：

```typescript
chunk.maps?.title
chunk.maps?.uri
chunk.maps?.placeId
```

我們將來源做成 LINE Flex Message carousel：

- 顯示咖啡廳名稱
- 標示「資料來源：Google Maps」
- 提供「在 Google Maps 查看」按鈕
- 讓使用者自行確認營業時間、照片、評論與導航

這讓推薦不再只是「AI 說的」，而是變成可以驗證的資訊。

使用者不是只能相信 AI，而是可以直接回到來源。

---

## 🧩 真實測試才發現：五張卡片裡，有三張可能是同一家店

TypeScript 編譯與單元測試都通過後，Codex 沒有停在假資料。

它用台北座標實際呼叫一次 Vertex Maps Grounding，只輸出摘要長度、來源數量與來源標題，不輸出敏感資料。

結果確實拿到 5 個來源，但標題中出現：

- 店家 Google Maps 頁面
- `Review of ...` 評論頁
- 同一店家的多個 review URLs

原本程式只看網址是否相同。偏偏同一家店的店家頁、不同評論頁，本來就有不同網址，因此全部被當成不同店家。

Codex 根據真實 response 修改策略：

1. 優先使用 `placeId` 當唯一 key。
2. 沒有 `placeId` 時，使用正規化店名。
3. 移除 `Review of` 與 `- Google Maps`。
4. 同一地點同時有店家頁與評論頁時，保留店家頁。

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

接著 Codex 把這個真實案例補進單元測試，確認 review 先出現、店家頁後出現時，最後仍會保留店家頁。

這一段很能代表我喜歡的 AI 協作方式：Codex 不是宣布「測試通過」就收工，而是真的去看使用者最後會看到什麼。

> 不是只把文件範例寫進專案，而是用真實 API 回應驗證，發現產品問題，再把問題變成測試。

---

## 🏆 第二篇實戰總結

這一篇完成了 AI 核心：

- Codex 對照文件與本機 SDK 型別
- 從 Gemini API key 改成 Vertex AI client
- 將 LINE 經緯度放入 `retrievalConfig.latLng`
- 用英文完成 Maps Grounding
- 用第二次 Vertex 呼叫翻成繁中
- Maps URL 不經模型改寫
- 使用 Flex Message 顯示 attribution
- 以真實 response 發現評論來源重複
- 用 `placeId` 去重並補上測試

此時本機功能已經能真正找到附近咖啡廳。

但下一篇才是最像正式產品的考驗：ADC 登入、IAM、quota project、Cloud Run runtime service account，以及「Webhook 明明回 200，使用者卻完全沒收到回答」。

👉 **下一篇：明明顯示 200 OK，LINE Bot 為什麼不回話？一次真實的 Cloud Run 除錯紀錄**

---

### 📂 專案開源與完整程式碼

👉 **GitHub：[https://github.com/zonawang/line-map-grounding](https://github.com/zonawang/line-map-grounding)**

👉 **更多 AI × LINE Bot 實作：[https://github.com/zonawang/zona-ai-learning-lab](https://github.com/zonawang/zona-ai-learning-lab)**
