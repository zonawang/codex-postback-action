# LINE Bot 實戰：用 Vertex AI Google Maps Grounding，打造會根據定位推薦附近咖啡廳的 AI 助手

大家哈囉！今天想記錄一個我自己非常喜歡的 LINE Bot 實戰：

**使用者只要在 LINE 裡傳送目前位置，Bot 就會透過 Vertex AI 的 Google Maps Grounding，找出附近 3～5 間咖啡廳，整理成繁體中文推薦，最後附上可以直接打開的 Google Maps 來源卡片。**

這個需求聽起來很直覺：

> 丟位置給 Bot，Bot 幫我找附近咖啡廳。

但真正做下去後，我才發現它一次串起了很多不同層次的問題：

- LINE 原生位置訊息（Location Message）
- Vertex AI 與 Application Default Credentials（ADC）
- Google Maps Grounding 的位置參數與資料來源
- 英文 Grounding、繁體中文回答的雙階段流程
- Google Cloud IAM、API 啟用與 quota project
- Cloud Run runtime service account
- LINE reply token、push message 與 webhook response 的生命週期
- Google Maps 店家來源與評論來源的去重

而今天最有價值的地方，也不是「最後有成功推薦咖啡廳」而已。

真正讓我學到最多的，是中間那些看起來像小問題、實際上卻會讓整個 Bot 完全沒反應的細節。

這篇文章會完整記錄今天的設計、實作流程，以及我們遇到的幾個真實踩坑。

---

## ☕ 我想做的互動流程其實很簡單

今天一開始，我先把使用者體驗定得非常清楚：

1. 使用者傳送「開始」或任意文字。
2. Bot 顯示 LINE 原生的「傳送目前位置」Quick Reply。
3. 使用者分享目前位置。
4. 後端取得 latitude 與 longitude。
5. Vertex AI 透過 Google Maps Grounding 搜尋附近咖啡廳。
6. 系統將英文 Grounded response 翻成台灣繁體中文。
7. Bot 回傳推薦摘要，以及每個 Google Maps 來源的 Flex Message 卡片。

這個流程有一個很重要的設計原則：

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

使用者點下按鈕後，LINE 會直接開啟地圖介面。送出的位置會進入 webhook，後端可以取得乾淨的經緯度，不需要自己解析「台北市信義區某某路」這種格式不固定的文字。

這跟我之前做 Datetime Picker、Camera Action 時的體會很像：

**只要 LINE 已經有原生輸入元件，就應該盡量讓使用者用點的，不要叫使用者自己打。**

---

## 🗺️ 這次不是只問 Gemini，而是讓回答真的 Grounding 在 Google Maps 上

一般的 LLM 很會回答「附近有什麼咖啡廳」，但如果沒有即時地圖資料，它很可能只是在使用模型記憶，甚至產生已歇業、位置錯誤或根本不存在的店家。

所以這次的重點不是單純呼叫 Gemini，而是啟用 **Google Maps Grounding**。

我們最後採用 Vertex AI / Gemini Enterprise Agent Platform 的方式進入，不使用 `GEMINI_API_KEY`，而是透過 Google Cloud 的 Application Default Credentials 與 Cloud Run service account 進行認證。

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

真正查詢咖啡廳時，Google Maps tool 與使用者位置會放在 `generateContent` 的設定中：

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

- 只推薦 3～5 間，避免訊息太長
- 優先考慮適合坐下來或使用筆電的店
- 沒有資料就不要亂說有插座、Wi-Fi 或不限時
- 回答必須建立在 Grounding 資料上

尤其是「沒有資料就不要亂說」這一條非常重要。

像插座、安靜程度、不限時這些資訊，不一定會出現在每間店的 Google Maps 資料裡。如果為了讓推薦看起來完整，硬叫 AI 每間都寫，反而很容易把不確定的資訊講得像真的。

---

## 🌏 為什麼要做「英文 Grounding、繁中轉譯」兩階段？

今天參考 Google Maps Grounding 文件時，我們確認到目前 Grounded prompt 與 response 需要使用英文。

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

Google Maps URL 則完全不經過翻譯模型，而是直接從 `groundingMetadata.groundingChunks` 取出。

這樣可以避免一個非常危險的情況：

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

## 🧩 坑點一：一開始用了 Gemini API key，後來才確認真正要走 Vertex AI

今天第一版架構原本是用 Gemini API key 與 Interactions API。

功能本身可以設計，但在重新確認指定文件後，我們發現這次真正想要的是：

**用 Google Cloud / Vertex AI 的身分進入，而不是在環境變數裡放一把 `GEMINI_API_KEY`。**

於是我們把整個認證方式改掉：

```env
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
```

本機使用：

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project your-project-id
```

Cloud Run 則使用專用 runtime service account，不放 service account JSON key，也不放 Gemini API key。

這次改版讓我重新理解一件事：

**「都是 Gemini」不代表呼叫入口、認證方式與回傳格式都一樣。**

Gemini Developer API、Vertex AI 與 Gemini Enterprise Agent Platform 的 SDK 寫法可能很接近，但在正式部署時，認證與 IAM 才是最容易卡住的地方。

---

## 🧩 坑點二：成功登入 Google，不代表你真的有專案權限

接下來遇到的是今天最典型的 Cloud IAM 問題。

我們執行 ADC 登入後，終端機顯示 credentials 已成功儲存，看起來一切正常。結果第一次實際呼叫 Vertex AI，直接收到：

```text
Permission 'aiplatform.endpoints.predict' denied
```

一開始很容易以為是 Vertex AI API 沒開，或 model 名稱打錯。但後來檢查才發現：登入時選到了另一個沒有 `line-zona` 權限的 Google 帳號。

這件事非常值得記住：

> Authentication 成功，只代表 Google 知道你是誰；Authorization 成功，才代表你可以操作這個 project。

我們後來重新指定正確帳號登入：

```bash
gcloud auth login <project-owner-account> --update-adc
```

再確認目前 active account、project 與 IAM role，才終於確定帳號真的具有 Owner 權限。

如果你也遇到 403，不要一直重跑登入。先確認三件事：

```bash
gcloud auth list
gcloud config get-value project
gcloud projects get-iam-policy your-project-id
```

很多時候不是你沒登入，而是你登入了錯的帳號。

---

## 🧩 坑點三：ADC quota project 設不上，原因竟然是 Cloud Resource Manager API 沒開

換成正確帳號之後，我們要把 quota project 設到目前專案：

```bash
gcloud auth application-default set-quota-project your-project-id
```

結果又失敗了。

錯誤訊息指出 `testIamPermissions` 無法執行，看起來像 IAM 不足，但更深一層的原因其實是：

```text
Cloud Resource Manager API has not been used or is disabled
```

解法是先啟用 API：

```bash
gcloud services enable cloudresourcemanager.googleapis.com
```

等待 operation 完成後，再重新設定 quota project，這次就成功了。

這個坑很容易誤判，因為它表面上同時出現「permission」與「API disabled」。

如果只看到 permission 就急著亂加 IAM role，可能繞一大圈還是沒有解決。

今天 Codex 在這裡的做法很實際：不是只看錯誤第一行，而是把完整 error details 往下讀，找到真正的 `SERVICE_DISABLED` reason，再針對缺少的 API 處理。

---

## 🧩 坑點四：Google Maps 回了 5 個來源，卻不代表是 5 間不同咖啡廳

第一次 Vertex Maps Grounding 實測成功時，我們真的拿到了 5 個 sources。

但仔細看標題，卻發現裡面同時包含：

- 店家的 Google Maps 頁面
- 同一間店的 Review 頁面
- 同一地點不同評論來源

如果直接全部做成 Flex Message，使用者會看到好幾張幾乎一樣的卡片，還以為 Bot 只會推薦同一間店。

所以我們不能只用 URL 去重，因為店家頁與評論頁本來就是不同 URL。

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

AI integration 後面通常還需要一層產品化整理，才能真正成為好用的使用者介面。

---

## 🧩 坑點五：Webhook 明明回 200，使用者傳位置後卻完全沒反應

今天最關鍵、也最值得寫下來的問題，發生在服務已經部署完成之後。

Cloud Run health check 正常。

LINE webhook Verify 也是 `200 OK`。

使用者傳送位置後，Cloud Run request logs 也確實看到 LINE 打進來，而且 HTTP status 是 200。

但是聊天室完全沒有回答。

這種狀況最容易讓人困惑，因為表面上所有檢查都綠了。

最後我們找到的根因，是 webhook route 一開始就執行：

```typescript
res.sendStatus(200);
```

然後才在背景等待 Vertex AI：

```typescript
await Promise.allSettled(events.map(handleWebhookEvent));
```

也就是說，HTTP request 已經結束，但真正的 Grounding 與 LINE reply 還沒做完。

在本機 Node.js 裡，背景 Promise 可能看起來還會繼續跑；但到了 Cloud Run，不能把「response 已結束後的背景工作」當成可靠的執行保證。

### 💡 最後的解法：Loading Animation + 保持 Request + Push Message

我們最後把流程改成：

1. 收到 location event。
2. 立即呼叫 LINE Loading Animation，讓使用者知道正在搜尋。
3. 保持 Cloud Run request，等待 Vertex Maps Grounding 完成。
4. 使用 LINE push message 發送推薦結果。
5. 所有 event 處理完成後，webhook 才回 HTTP 200。

```typescript
await lineClient.showLoadingAnimation({
  chatId: targetId,
  loadingSeconds: 60
});

const result = await findNearbyCafes(latitude, longitude);

await lineClient.pushMessage({
  to: targetId,
  messages: createCafeResultMessages(result)
});

res.sendStatus(200);
```

為什麼最後使用 push message，而不是等 30 秒後再用 reply token？

因為 Grounding 與翻譯需要時間。把長時間工作綁在 reply token 上，會增加 token 過期或 webhook lifecycle 不一致的風險。Push message 讓結果傳送與原始 reply token 解耦，流程更穩定。

我們也補上結構化 logs：

- `Webhook event received`
- `Cafe search started`
- `Cafe search reply sent`
- `Cafe search failed`
- `elapsedMs`
- `sourceCount`

這次修復後，除錯方式也從「使用者說沒反應，只能猜」變成「可以直接知道卡在哪一個階段」。

這就是 observability 真正的價值。

---

## ☁️ Cloud Run 不只是部署，runtime 身分也要一起設計

今天部署時，我們沒有讓服務直接使用預設的高權限帳號，而是建立專用的 runtime service account：

```text
line-map-grounding@<project-id>.iam.gserviceaccount.com
```

再授予它執行 Vertex AI 所需的角色：

- `roles/aiplatform.user`
- `roles/serviceusage.serviceUsageConsumer`

部署時明確指定：

```bash
gcloud run deploy line-map-grounding \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --service-account line-map-grounding@<project-id>.iam.gserviceaccount.com \
  --env-vars-file cloud-run-env.yaml
```

這裡的 `--no-cpu-throttling`，是因為 webhook 流程包含較長的 Vertex AI 查詢。即使服務沒有設定 minimum instances、閒置時仍能縮到 0，我們也希望 instance 在處理期間有穩定 CPU。

部署完成後，我們做了三層驗證：

1. `GET /health` 回傳 `{"status":"ok"}`。
2. LINE Messaging API webhook test 回傳 `200 OK`。
3. 實際從手機傳送位置，確認 Loading Animation、Grounding 與 Flex Message 都能走完。

第三層才是真正的 end-to-end 測試。

只測 health 與 webhook Verify，不代表產品流程真的正常。今天「傳位置沒反應」就是最好的例子。

---

## 🧱 今天最後完成的專案結構

這次專案從一個全新的空 GitHub repo 開始，最後整理成 TypeScript + Express 的模組化架構：

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
    geminiMaps.ts
    geminiMaps.test.ts
    lineClient.ts
  utils/
    env.ts
    logger.ts
```

每一層責任都很清楚：

- `routes/webhook.ts`：驗證 LINE signature、管理 webhook request lifecycle
- `handlers/webhookEventHandler.ts`：處理 text 與 location event
- `services/geminiMaps.ts`：Vertex AI、Google Maps Grounding、翻譯與來源整理
- `messages/cafeMessages.ts`：LINE 文字訊息與 Flex Message
- `utils/env.ts`：環境變數檢查
- `utils/logger.ts`：Cloud Logging 可讀的結構化 logs

這樣的拆分，讓今天後面修 webhook lifecycle 時，不需要把 Gemini、LINE UI 與 Express route 全部攪在一起改。

---

## 🤝 我對 Codex 更深的一個感受：真正有價值的是陪你把線上問題查到底

如果今天只是叫 AI 生一段 Google Maps Grounding 範例，可能半小時內就會有一份看起來能用的 code。

但一個真的能讓使用者在 LINE 裡傳位置、收到咖啡廳推薦的產品，中間還有非常長的一段路：

- 確認正確文件與 API 入口
- 從 API key 改成 Vertex AI ADC
- 找出登入錯誤帳號的 IAM 問題
- 啟用缺少的 Google Cloud API
- 建立最小權限 runtime service account
- 驗證真實 Maps Grounding response
- 處理重複 Google Maps sources
- 部署 Cloud Run
- 設定 LINE webhook
- 讀 Cloud Logging 找出「200 但沒回答」的生命週期問題
- 修正 Loading Animation 與 push message 流程
- 重新部署、實機測試、提交 GitHub

Codex 今天最像工程夥伴的地方，不是它一次就把所有東西寫對。

而是當線上行為跟預期不一樣時，它可以繼續讀 logs、驗證假設、找到根因、修改、部署，再重新測一次。

這也讓我今天最有感的一句話是：

> AI 寫出程式碼只是起點；AI 能陪你把真實系統跑通，才是完整的開發協作。

---

## 🏆 今天的實戰總結

今天我們完成的不只是一個「找附近咖啡廳」的小功能，而是一條完整的 location-aware AI product pipeline：

- **零打字位置輸入**：使用 LINE 原生 Location Action 分享位置
- **即時地圖 Grounding**：透過 Vertex AI 使用 Google Maps 資料
- **繁體中文體驗**：英文 Grounding、繁中轉譯，保留事實與店名
- **來源可驗證**：每個推薦附上 Google Maps Flex Message
- **來源去重**：用 `placeId` 合併店家頁與評論頁
- **無 API key 架構**：本機使用 ADC，Cloud Run 使用 runtime service account
- **可靠 webhook 流程**：Loading Animation + Vertex 查詢 + push message
- **完整雲端部署**：Cloud Run、IAM、health check、LINE Verify
- **可觀測性**：每個處理階段都有結構化 Cloud Logging

如果你也想做「附近餐廳」、「旅遊景點推薦」、「親子設施」、「寵物友善店家」或「臨時找一個適合工作的地方」，這套架構都可以直接延伸。

下一步還可以繼續加入：

- 有插座、Wi-Fi、不限時等搜尋條件
- 「換一批」與距離篩選
- 收藏店家
- 儲存最近位置
- 使用者偏好與歷史推薦
- Cloud Tasks，讓長時間 webhook 工作更耐重試

今天先把最重要的第一版真正做完：

**使用者傳一個位置，Bot 真的能根據附近的 Google Maps 資料，回一份有來源、能打開、看得懂的咖啡廳推薦。**

---

### 📂 專案開源與完整程式碼

本次完整程式碼，包含 LINE Location Action、Vertex AI Google Maps Grounding、繁中轉譯、Flex Message、Cloud Run 與 webhook lifecycle 修正，都已整理在 GitHub：

👉 **GitHub 儲存庫：[https://github.com/zonawang/line-map-grounding](https://github.com/zonawang/line-map-grounding)**

👉 **更多過往 AI × LINE Bot 實作：[https://github.com/zonawang/zona-ai-learning-lab](https://github.com/zonawang/zona-ai-learning-lab)**

如果你也正在開發 location-based AI Bot，或遇到 Grounding、IAM、Cloud Run、LINE webhook 相關問題，歡迎到 GitHub 開 Issue 一起交流！🌟
