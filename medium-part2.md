# 用 Vertex AI Google Maps Grounding 找咖啡廳：從文件轉向、繁中轉譯到來源去重

上一篇，我和 Codex 從空 GitHub repo 建立了 LINE Bot 骨架，並用 Location Action 取得乾淨的 latitude 與 longitude。

這一篇要進入真正的 AI 核心：

> 如何把位置交給 Vertex AI Google Maps Grounding，產生有來源的咖啡廳推薦？

這一段最有趣的地方，是我們中途根據文件改變了整個 API 入口，而且真實 response 又讓我們發現：**有 5 個來源，不代表有 5 間不同咖啡廳。**

---

## 🧭 Codex 的第一個工作不是寫 Code，而是確認我們到底該用哪份文件

第一版原本參考 Gemini API Maps Grounding 文件，採用 API key 與 Interactions API。

後來我指定另一份 Google Cloud 文件，並明確要求：

**要走 Vertex AI，不要使用 Gemini API key。**

Codex 沒有只替換環境變數名稱，而是重新比對：

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

這次讓我很有感：Codex 不只是搜尋文件，它還會用本機實際安裝版本的型別再驗證一次。

文件告訴我們「概念怎麼用」，SDK declarations 則告訴我們「這個專案現在到底能怎麼寫」。

---

## 🗺️ 從 API Key 改成 Vertex AI 身分

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

這就是整合型修改和單點改 code 的差別。

如果只改 client，其他文件與部署設定仍然叫人放 API key，下一個使用者一定會混亂。

---

## 📍 把 LINE 經緯度放進 Google Maps Retrieval Config

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

Prompt 裡我特別保留一句：

> 沒有資料時，不要自行宣稱有插座、Wi-Fi、不限時或安靜。

這些條件很適合咖啡廳推薦，但不一定存在於每間店的 Maps 資料裡。

Codex 在這裡沒有幫我把答案「補得更完整」，反而替 prompt 加上事實邊界。對 Grounded product 來說，少說一點通常比自信地猜更好。

---

## 🌏 英文 Grounding、繁中轉譯，為什麼要拆兩次呼叫？

Google Maps Grounding 文件要求 Grounded prompt 與 response 使用英文，但 LINE 使用者希望看到繁體中文。

所以 Codex 設計成兩階段：

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

Codex 也替翻譯加上 fallback：如果第二次模型呼叫失敗，至少保留原始英文 Grounded response，不讓整個推薦流程跟著中斷。

---

## 🔗 回答要有 Google Maps Attribution，不只是好看而已

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

這讓推薦變得可以驗證。

使用者不是只能相信 AI，而是可以直接回到來源。

---

## 🧩 真實 API 測試抓到的問題：Review URL 塞滿整個 Carousel

TypeScript 編譯與單元測試都通過後，Codex沒有停在 mock data。

它用台北座標實際呼叫一次 Vertex Maps Grounding，只輸出摘要長度、來源數量與來源標題，不輸出敏感資料。

結果確實拿到 5 個來源，但標題中出現：

- 店家 Google Maps 頁面
- `Review of ...` 評論頁
- 同一店家的多個 review URLs

原本解析器只用 URL 去重，因此不同評論 URL 都被當成不同店家。

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

這一段很能代表我喜歡的 AI 協作方式：

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

👉 **下一篇：LINE Webhook 200 卻沒回覆——用 Codex 排查 ADC、IAM、Cloud Run 與非同步生命週期**

---

### 📂 專案開源與完整程式碼

👉 **GitHub：[https://github.com/zonawang/line-map-grounding](https://github.com/zonawang/line-map-grounding)**

👉 **更多 AI × LINE Bot 實作：[https://github.com/zonawang/zona-ai-learning-lab](https://github.com/zonawang/zona-ai-learning-lab)**
