# LINE Bot 實戰（下）：從 ADC、IAM 到 Cloud Run，解決 Webhook 200 卻完全沒回覆的問題

大家哈囉！上一篇我們完成了一個會根據 LINE 定位，透過 Vertex AI Google Maps Grounding 推薦附近咖啡廳的 Bot。

在本機測試時，模型能找到店家、繁中摘要能生成、Google Maps 卡片也能組出來，看起來已經離完成很近。

但真正把服務部署到 Google Cloud 後，才進入今天最像實戰的部分：

- ADC 明明登入成功，Vertex AI 卻回 403
- quota project 設不上
- Cloud Run 該用誰的身分呼叫 Vertex
- LINE webhook Verify 明明是 200 OK
- 使用者真的傳送位置後，聊天室卻完全沒有反應

這一篇會專門記錄「程式寫完之後」的那一半：認證、權限、部署、observability，以及 webhook lifecycle。

因為一個 AI Bot 能不能成為產品，往往不是看 code 能不能 build，而是看整條線上鏈路能不能真的走完。

---

## 🧩 挑戰一：成功登入 Google，不代表你真的有專案權限

我們採用 Vertex AI，不使用 `GEMINI_API_KEY`。

本機開發時，先執行 Application Default Credentials 登入：

```bash
gcloud auth application-default login
```

終端機顯示 credentials 已成功儲存，看起來一切正常。結果第一次實際呼叫 Vertex AI，直接收到：

```text
Permission 'aiplatform.endpoints.predict' denied
```

一開始很容易以為是 Vertex AI API 沒開，或 model 名稱打錯。但後來檢查才發現：登入時選到了另一個沒有目標 project 權限的 Google 帳號。

這件事非常值得記住：

> Authentication 成功，只代表 Google 知道你是誰；Authorization 成功，才代表你可以操作這個 project。

我們後來重新指定正確帳號登入並同步 ADC：

```bash
gcloud auth login <project-owner-account> --update-adc
```

接著確認 active account、project 與 IAM role：

```bash
gcloud auth list
gcloud config get-value project
gcloud projects get-iam-policy your-project-id
```

如果你也遇到 403，不要只是不斷重跑登入。

很多時候不是你沒登入，而是你登入了錯的帳號，或該帳號根本不在 project IAM 裡。

---

## 🧩 挑戰二：ADC quota project 設不上，原因竟然是 API 沒開

換成正確帳號後，我們要把 ADC quota project 設到目前專案：

```bash
gcloud auth application-default set-quota-project your-project-id
```

結果又失敗了。

錯誤訊息指出 `testIamPermissions` 無法執行，看起來像 IAM 不足，但完整 error details 裡真正的 reason 是：

```text
Cloud Resource Manager API has not been used or is disabled
```

解法是先啟用 API：

```bash
gcloud services enable cloudresourcemanager.googleapis.com
```

等待 operation 完成後，再重新設定 quota project，這次就成功了。

這個坑很容易誤判，因為錯誤同時出現「permission」與「API disabled」。

如果只看到第一行就急著亂加 IAM role，可能繞一大圈還是沒有解決。

這次 Codex 的處理方式很實際：不是只看錯誤摘要，而是把完整 details 往下讀，找到真正的 `SERVICE_DISABLED` reason，再針對缺少的 API 處理。

---

## ☁️ Cloud Run 不只要部署，runtime 身分也要一起設計

本機 ADC 可以使用開發者帳號，但 Cloud Run 不應該帶著某個人的本機 credentials 上線。

我們建立了一個專用 runtime service account：

```text
line-map-grounding@<project-id>.iam.gserviceaccount.com
```

再授予它執行 Vertex AI 所需的最小角色：

- `roles/aiplatform.user`
- `roles/serviceusage.serviceUsageConsumer`

相關指令如下：

```bash
gcloud iam service-accounts create line-map-grounding \
  --display-name="LINE Map Grounding"

gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:line-map-grounding@your-project-id.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

部署時再明確指定 service account：

```bash
gcloud run deploy line-map-grounding \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --service-account line-map-grounding@your-project-id.iam.gserviceaccount.com \
  --env-vars-file cloud-run-env.yaml
```

這樣做的好處是：

- 本機與正式環境使用相同的 Google Cloud 身分模型
- 不需要放 Gemini API key
- 不需要上傳 service account JSON key
- runtime 權限可以獨立管理
- 之後要撤銷或縮小權限比較清楚

---

## ✅ Health 正常、Webhook Verify 成功，為什麼還不能放心？

部署完成後，我們做了兩個最基本的檢查。

第一個是 Cloud Run health：

```bash
curl https://<service-url>/health
```

成功回傳：

```json
{"status":"ok"}
```

第二個是 LINE Messaging API webhook test，也成功得到：

```text
200 OK
```

到這裡看起來非常完美。

但當使用者真的從手機傳送位置後，LINE 聊天室完全沒有回答。

這就是今天最關鍵的提醒：

> Health check 與 Webhook Verify 只能證明入口活著，不代表完整使用者流程真的成功。

真正的 end-to-end test，仍然要從手機實際送出 location event。

---

## 🧩 挑戰三：Webhook 明明回 200，使用者卻完全沒收到回答

我們先查 Cloud Run request logs，確認幾件事：

- LINE 確實有送出 `POST /webhook`
- Cloud Run 確實收到 request
- signature middleware 沒有拒絕
- HTTP status 確實是 200

但應用程式沒有留下 Grounding 完成或 LINE reply 成功的紀錄。

最後找到的根因，是 webhook route 一開始就執行：

```typescript
res.sendStatus(200);
```

然後才在背景等待 Vertex AI：

```typescript
await Promise.allSettled(events.map(handleWebhookEvent));
```

也就是說，HTTP response 已經結束，但真正的 Grounding 與 LINE reply 還沒做完。

在本機 Node.js 裡，背景 Promise 可能看起來仍會繼續跑；但到了 Cloud Run，不能把 response 結束後的背景工作當成可靠保證。

這就是為什麼 request logs 全部是漂亮的 200，使用者體感卻像 Bot 壞掉。

---

## 💡 最後的解法：Loading Animation + 保持 Request + Push Message

最後我們把流程改成：

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

為什麼最後使用 push message，而不是等 Grounding 完成後再使用 reply token？

因為 Grounding 與翻譯需要時間。把長時間工作綁在 reply token 上，會增加 token 過期或 webhook lifecycle 不一致的風險。

Push message 讓結果傳送與原始 reply token 解耦，流程更穩定。

Loading Animation 也很重要。

以前使用者傳位置後，畫面完全靜止，只能猜 Bot 是壞掉還是在處理。現在一送出位置，就會先看到載入狀態，20～40 秒後再收到推薦結果，體感差非常多。

---

## 🔍 沒有 Logs，就只能一直猜

這次出問題時，原本程式只有失敗才寫 log，成功路徑幾乎沒有紀錄。

所以我們補上每個關鍵階段：

- `Webhook event received`
- `Cafe search started`
- `Cafe search reply sent`
- `Cafe search failed`
- `elapsedMs`
- `sourceCount`

```typescript
logger.info('Cafe search reply sent', {
  webhookEventId: event.webhookEventId,
  sourceCount: result.sources.length,
  elapsedMs: Date.now() - startedAt
});
```

改完後，除錯方式從：

> 使用者說沒反應，我們從頭猜一次。

變成：

> Event 有收到、Grounding 有開始、花了幾秒、來源有幾個、Push 是否成功。

這就是 observability 真正的價值。

它不是讓 dashboard 看起來更專業，而是線上出問題時，能快速知道工作停在哪一站。

---

## 🧪 我最後採用的驗證順序

這次做完後，我把 LINE Bot 的測試順序整理成五層：

### 第一層：程式驗證

```bash
npm run typecheck
npm test
```

### 第二層：服務啟動

```bash
curl http://localhost:3000/health
```

### 第三層：Cloud Run health

```bash
curl https://<service-url>/health
```

### 第四層：LINE webhook Verify

確認 webhook endpoint、active status 與 test result 都正常。

### 第五層：手機 end-to-end test

1. 傳送「開始」
2. 點擊「傳送目前位置」
3. 確認 Loading Animation 出現
4. 等待 Grounding 完成
5. 確認繁中摘要與 Google Maps 卡片出現
6. 查看 Cloud Logging 是否有完整成功紀錄

前四層都通過，仍然不能取代第五層。

---

## 🤝 我對 Codex 更深的一個感受：真正有價值的是陪你把線上問題查到底

如果今天只是叫 AI 生一段 Google Maps Grounding 範例，很快就會有一份看起來能用的 code。

但一個真的能讓使用者在 LINE 裡傳位置、收到咖啡廳推薦的產品，中間還有非常長的一段路：

- 確認正確 API 與認證入口
- 從 API key 改成 Vertex AI ADC
- 找出登入錯誤帳號的 IAM 問題
- 啟用缺少的 Google Cloud API
- 建立最小權限 runtime service account
- 部署 Cloud Run
- 設定 LINE webhook
- 讀 Cloud Logging 找出「200 但沒回答」的生命週期問題
- 修正 Loading Animation 與 push message
- 重新部署並進行手機實測

Codex 今天最像工程夥伴的地方，不是它一次就把所有東西寫對。

而是當線上行為跟預期不一樣時，它可以繼續讀 logs、驗證假設、找到根因、修改、部署，再重新測一次。

這也讓我今天最有感的一句話是：

> AI 寫出程式碼只是起點；AI 能陪你把真實系統跑通，才是完整的開發協作。

---

## 🏆 下篇實戰總結

這一篇解決的是 AI Bot 最容易被低估的「最後一公里」：

- **正確 Google 身分**：登入成功不等於有 project 權限
- **完整 ADC 設定**：確認 quota project 與必要 API
- **最小權限部署**：Cloud Run 使用專用 runtime service account
- **真實 end-to-end 測試**：不只看 health 與 Verify
- **可靠 webhook lifecycle**：不要先結束 response 再期待背景工作一定完成
- **更好的等待體驗**：Loading Animation 告訴使用者 Bot 正在工作
- **結果與 token 解耦**：使用 push message 回傳長時間任務結果
- **完整 observability**：每個階段都能從 Cloud Logging 追蹤

如果你也在做需要呼叫 LLM、圖片分析、外部搜尋或其他長時間任務的 LINE Bot，今天這個 webhook lifecycle 問題非常值得先記起來。

因為最難查的 Bug，往往不是 500 error。

而是每個監控表面上都顯示成功，使用者卻什麼都沒收到。

---

### 📂 專案開源與完整程式碼

本次完整程式碼，包含 LINE Location Action、Vertex AI Google Maps Grounding、Cloud Run 與 webhook lifecycle 修正，都已整理在 GitHub：

👉 **GitHub 儲存庫：[https://github.com/zonawang/line-map-grounding](https://github.com/zonawang/line-map-grounding)**

👉 **更多過往 AI × LINE Bot 實作：[https://github.com/zonawang/zona-ai-learning-lab](https://github.com/zonawang/zona-ai-learning-lab)**

如果你也正在開發 location-based AI Bot，或遇到 Grounding、IAM、Cloud Run、LINE webhook 相關問題，歡迎到 GitHub 開 Issue 一起交流！🌟
