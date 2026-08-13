# 從按鈕到真正上線：我和 Codex 實作 LINE Postback、Fallback 與安全切換

上一篇，我和 Codex 先處理了「換一批」背後最重要的狀態問題：用短 Postback data 指向 Firestore session，再用使用者驗證、過期時間與 transaction 鎖保護它。

但資料模型設計完成，不代表使用者已經可以按。

今天接下來的工作，是把這套設計接進既有 Zona Cafe：收到 Postback event、找回上次位置、避開上一批店家、更新搜尋偏好、組出新的 LINE 按鈕，最後在不關掉舊服務的情況下切換正式 webhook。

這篇不重講 Google Maps Grounding 怎麼查、Cloud Run 是什麼，也不再介紹 Loading Animation。只記錄這次 Postback 功能新增的程式邊界、測試策略，以及 Codex 如何做一次可回復的線上切換。

---

## 🧩 Codex 先把 Postback 從原本的 Message 流程分出去

原本的 webhook handler 主要處理文字與位置訊息。Postback 加進來後，Codex 沒有把判斷全部塞進 location 區塊，而是在事件進入點先分流：

```typescript
if (event.type === 'postback') {
  await handlePostbackEvent(event);
  return;
}

if (event.type !== 'message') {
  return;
}
```

新的 `postbackHandler.ts` 只負責 Postback 的生命週期：

1. 解析按鈕帶回來的資料
2. 驗證 action 與 session
3. 取得 Firestore 處理鎖
4. 組合新的搜尋條件
5. 呼叫既有咖啡廳搜尋服務
6. 更新 session
7. 將新結果推回原聊天室

Codex 保留原本 location 搜尋的責任，也讓未來新增 `favorite` 或 `feedback` 時有清楚的擴充入口。

這不是為了多建立一個檔案，而是避免「第一次搜尋」與「沿用舊狀態再搜尋」兩種不同流程互相纏住。

---

## 🧾 Postback data 先經過 Parser，不直接進商業邏輯

Postback data 長得像 query string：

```text
v=1&a=reroll&s=abc123
```

Codex 沒有在 handler 裡到處呼叫 `params.get()`，而是建立專用 parser，把外部輸入轉成程式內可信任的型別。

```typescript
type CafePostbackAction = 'reroll' | 'work_friendly';

type ParsedCafePostback = {
  action: CafePostbackAction;
  sessionId: string;
};
```

Parser 會拒絕：

- 不是 `v=1` 的資料
- 不在白名單內的 action
- 缺少 session ID
- 含有斜線或不合法字元的 session ID

這個邊界很重要。

Firestore 的 document path、Gemini prompt 與後續 handler 都不應該直接接受一段未驗證字串。Codex 讓資料一進系統就先被縮成兩種明確 action，後面的程式不需要反覆猜測輸入是否安全。

版本欄位 `v=1` 也替未來留下空間。哪天 data 格式真的要改，Codex 可以新增 `v=2` parser，而不是讓新舊按鈕互相誤解。

---

## 🔄 「換一批」的核心不是 Random，而是記住上一批

如果使用相同座標與相同 prompt 再查一次，Gemini 很可能仍然推薦最熱門、最接近的幾間店。

所以 Codex 讓每次成功搜尋後，都把新的店名寫回 `previousCafeNames`。

下一次 Postback 會把這些名稱傳進搜尋服務：

```typescript
const result = await findNearbyCafes(
  session.latitude,
  session.longitude,
  {
    preference,
    excludeNames: session.previousCafeNames
  }
);
```

搜尋 prompt 不是要求模型絕對排除，而是「有其他合理選擇時，推薦不同店家」。

Codex 保留這個彈性，因為有些地點附近本來就只有少數可用咖啡廳。如果寫成硬性禁止，模型可能為了湊數而拉遠距離，甚至降低 Grounding 品質。

「更適合工作」則會把 session preference 更新成 `work_friendly`。後續再按「換一批」，仍會保留這個偏好，不會突然回到預設搜尋。

Codex 同時要求模型只能根據 Google Maps 可取得的明確資訊做判斷，沒有證據時不能自行補上插座、Wi-Fi、不限時或安靜等描述。

所以這個按鈕代表「搜尋時更重視工作情境」，不是一張虛構的設備保證書。

---

## 💬 Quick Reply 顯示文字與後端指令，刻意分成兩件事

使用者看到的是：

```text
🔄 換一批咖啡廳
```

後端收到的則是：

```text
v=1&a=reroll&s=<sessionId>
```

Codex 透過 Postback action 的 `displayText` 與 `data` 把兩者分開：

```typescript
{
  type: 'postback',
  label: '換一批',
  displayText: '🔄 換一批咖啡廳',
  data: createCafePostbackData('reroll', sessionId)
}
```

`displayText` 是給人看的，讓聊天室保留一段自然操作紀錄；`data` 是給程式看的，維持短、小、可驗證。

結果下方最後有三個 Quick Reply：

- 換一批：Postback action
- 更適合工作：Postback action
- 重新選位置：Location action

Codex 沒有為了統一格式犧牲語意。需要後端狀態的才用 Postback，需要手機重新提供座標的仍交給 LINE 原生位置介面。

---

## 🧯 Codex 為每個失敗階段準備不同回答

Postback 的錯誤不只有一種。

如果全部只回「發生錯誤」，使用者不知道該等待、重按，還是重新傳位置。

Codex 依照狀態提供不同訊息：

- Session 正在處理：請等待上一個結果
- Session 過期或不存在：請重新傳送位置
- Session 屬於其他人：這個按鈕無法由目前使用者操作
- Gemini 或外部服務失敗：稍後再試
- Postback data 無法辨識：重新建立一次搜尋

錯誤訊息下方會附上「重新傳送位置」，讓使用者不需要自己猜下一步。

另一個比較不容易看到的 fallback 發生在第一次搜尋。

如果咖啡廳結果已經找到，但 Firestore session 建立失敗，Codex 不會丟掉整份推薦。Bot 仍會送出摘要與 Google Maps 卡片，只是不顯示需要 session 的兩個 Postback 按鈕。

這個處理讓新增的互動能力不會反過來降低原本功能的可用性。

---

## 🧪 測試重點不是 Gemini 會推薦哪間店

地點推薦會受到位置、Maps 資料與模型回應影響，不適合用單元測試固定某一家店。

Codex 把測試放在這次程式真正能控制的邊界。

### Postback data

- `reroll` 可以正確產生與還原
- 產生結果沒有超過 LINE 的 300 字限制
- 錯誤版本會被拒絕
- 未知 action 會被拒絕
- 不合法 session ID 會被拒絕

### LINE 訊息

- 有 session 時，結果包含兩個 Postback 與一個 location action
- 沒有 session 時，只保留 location action

### 原本能力

- Google Maps source 去重仍然通過
- TypeScript 全專案型別檢查仍然通過

最後 Codex 執行：

```bash
npm run typecheck
npm test
```

5 項測試全部成功。

這組測試不嘗試證明外部世界永遠穩定，而是確認不管外部結果怎麼變，Postback protocol、訊息形狀與降級行為都維持一致。

---

## 🛤️ 這次上線最重要的設計：不要直接蓋掉舊服務

過往文章已經寫過 Cloud Run 基本部署與 IAM 除錯，所以這次 Codex 沒有再重做一遍相同流程。

今天真正新增的部署策略是「平行服務」：

```text
舊服務：line-map-grounding
新服務：codex-postback-action
```

Codex 先將完整基底與 Postback 功能放進新的 GitHub repo，再部署成另一個 Cloud Run service。

這樣做有三個好處：

1. 舊 Bot 在開發與部署期間不受影響。
2. 新服務可以先做 health check 與 log 檢查。
3. Webhook 切換失敗時，舊網址仍然存在，可以立刻切回。

這次新增的 Firestore 存取也使用獨立 runtime service account，只補上實際需要的三個角色：

```text
roles/aiplatform.user
roles/datastore.user
roles/serviceusage.serviceUsageConsumer
```

Codex 沒有把舊 service account 擴權後共用，而是讓新服務的身分與權限可以獨立追蹤。

---

## 🔁 Codex 把 Webhook 切換寫成「成功才留下，失敗就回復」

新 Cloud Run revision serving 100% traffic、`/health` 回傳正常，還不代表應該直接把正式 Bot 指過去。

Codex 在切換前先讀取目前 webhook endpoint，保留舊網址：

```text
https://line-map-grounding-.../webhook
```

接著才將 LINE webhook 更新成新服務：

```text
https://codex-postback-action-.../webhook
```

切換腳本緊接著呼叫 LINE 官方 webhook test。如果 `success` 不是 `true`，Codex 會在同一次流程裡把 endpoint 設回舊網址。

概念上是：

```typescript
const oldEndpoint = await getCurrentWebhook();

try {
  await setWebhook(newEndpoint);
  const result = await testWebhook(newEndpoint);

  if (!result.success) {
    await setWebhook(oldEndpoint);
  }
} catch {
  await setWebhook(oldEndpoint);
}
```

最後新服務得到：

```text
success: true
statusCode: 200
reason: OK
```

Codex 再確認 Cloud Run 沒有 error logs，才把這次切換視為完成。

這和「部署指令顯示 Done」是不同層次的完成。真正重要的是，新入口可達，而且失敗時有已經確認過的回復位置。

---

## 🧹 TTL 建立比較慢，但不應阻擋功能上線

Firestore TTL 政策建立後，Google Cloud 需要一段時間在背景完成設定。

Codex 查到 operation 狀態仍是：

```text
PROCESSING
```

這時不需要把整個 Bot 回復到舊版。

因為應用程式本身已經會用 `expiresAt` 拒絕超過 30 分鐘的 session。TTL 處理的是之後自動刪除文件，不是即時授權。

Codex 將它判定為「背景清理尚在建立」，而不是「Postback 功能不可使用」。這正好呼應上一篇的責任分工：程式負責守門，TTL 負責打掃。

---

## 🏆 第二篇總結：完成不是程式寫完，而是能安全替換線上入口

今天 Codex 實作的不只是兩個 LINE 按鈕。

它把 Postback 功能拆成一組可以驗證的邊界：

- Event type 分流
- 版本化 parser
- Action 白名單
- Firestore session claim
- 上一批店家排除
- 搜尋偏好延續
- Quick Reply 組裝
- 分類錯誤訊息
- Firestore 失敗時的降級
- Protocol 與訊息測試

接著 Codex 又把上線變成一個可回復流程：新舊服務平行存在、先檢查新服務、保留舊 endpoint、切換後立即 Verify、失敗自動切回。

這些步驟大多不會出現在使用者畫面上，但它們決定了一次新功能發布，是「希望它會成功」，還是「知道失敗時怎麼回來」。

我今天最有感的一句話是：

> Codex 寫 code 的速度很快，但真正讓我放心的，是它願意把 parser、fallback、測試與回復路徑一起做完。

現在 Zona Cafe 不只會回答「附近有什麼」，也開始能記住一次搜尋，讓使用者沿著同一個情境繼續探索。

---

### 📂 本篇完整程式碼

👉 Postback Action 專案：
https://github.com/zonawang/codex-postback-action

👉 第一篇：LINE Bot 的「換一批」為什麼需要資料庫？
https://github.com/zonawang/codex-postback-action/blob/main/medium-postback-part1.md

👉 更多過往專案整理：
https://github.com/zonawang/zona-ai-learning-lab
