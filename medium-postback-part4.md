# 不直接蓋掉舊 Bot：Codex 如何讓 LINE Webhook 成功才切換、失敗就回復

Postback 功能完成並通過測試後，最後一個問題是：怎麼把它放到正式 Zona Cafe，又不讓目前可用的 Bot 陪著一起冒險？

以前的文章已經寫過 Cloud Run、service account 與 LINE webhook 基礎，這篇不再重講。

今天真正的新做法是「可回復切換」：Codex 保留舊服務，平行部署新版，先驗證，再改 webhook；任何一步失敗，就回到已知可用的舊網址。

---

## 🛤️ Codex 沒有直接在舊 Repo 上改正式服務

這次我指定了一個新的 GitHub repo：

```text
https://github.com/zonawang/codex-postback-action
```

Codex 發現 repo 是空的，因此以目前 `line-map-grounding` 的最新版本作為基底，再加入 Postback 功能。

原本的 repo 與 Cloud Run service 都保持不動：

```text
舊服務：line-map-grounding
新服務：codex-postback-action
```

這不是為了長期維護兩套 Bot，而是讓發布當下有兩個清楚狀態：

- 舊服務：已知可以使用
- 新服務：等待驗證

Codex 可以在不影響使用者的情況下部署與檢查新版，也保留最直接的回復位置。

---

## 🔐 新功能使用自己的 Runtime 身分

Postback 新增 Firestore session，因此新服務需要比舊版多一種資料存取能力。

Codex 沒有把舊 service account 直接擴權後共用，而是建立新的 runtime service account，只授予實際需要的角色：

```text
roles/aiplatform.user
roles/datastore.user
roles/serviceusage.serviceUsageConsumer
```

這篇不再解釋 IAM 基礎；這次值得記錄的是「新服務有獨立身分」。

未來看到 Firestore 或 Vertex AI audit log 時，可以直接知道是哪個版本的 Bot 在操作，也能單獨停用新版權限而不影響舊服務。

---

## ✅ Webhook 切換前，先證明新服務至少站得起來

部署完成後，Codex 沒有立刻修改 LINE 設定。

它先確認：

- 新 revision 已承接 100% 新服務流量
- `/health` 回傳正常
- 啟動 logs 沒有 error
- Firestore database 與必要 API 已存在
- 舊服務 URL 仍可作為回復位置

這些檢查不能代替手機實測，但能先擋掉容器起不來、環境變數缺失或服務入口錯誤等問題。

Codex 把「部署成功」與「可以接正式 webhook」視為兩個不同階段。

---

## 🧷 切換前先讀取舊網址，不靠記憶回復

真正改 webhook 前，Codex 先透過 LINE API 讀取目前 endpoint：

```text
https://line-map-grounding-.../webhook
```

再準備新 endpoint：

```text
https://codex-postback-action-.../webhook
```

為什麼不直接把舊網址手動寫進腳本？

因為正式設定可能已經被改過。Codex 以 LINE 當下回傳的值作為回復來源，避免「以為的舊網址」和「真正的舊網址」不同。

---

## 🔁 Codex 把切換與 Verify 放在同一個流程

這次最重要的步驟，是更新 endpoint 後立刻呼叫 LINE 官方 webhook test。

概念如下：

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

成功時，新網址留下；Verify 失敗或 API 中途拋錯時，Codex 在同一個流程裡切回舊網址。

最後 LINE 回傳：

```text
success: true
statusCode: 200
reason: OK
```

Codex 再檢查新服務沒有 error logs，正式 webhook 才算完成切換。

這比部署後直接手動貼網址多了一個重要保證：失敗路徑不是臨時想，而是切換前就已經寫好。

---

## 🧹 TTL 還在 Processing，為什麼不需要回復？

Firestore TTL 建立比服務部署慢。Codex 查詢時，Google Cloud operation 仍顯示：

```text
PROCESSING
```

但這不代表 Postback 不能使用。

應用程式本身已經會根據 `expiresAt` 拒絕超過 30 分鐘的 session。TTL 只負責之後自動清理過期文件，不參與即時授權。

Codex 因此把它判斷為「背景清理尚未完成」，而不是「線上功能失敗」。

可回復發布不代表任何非同步工作都要瞬間完成，而是要知道哪些狀態會影響使用者、哪些可以安全地在背景繼續。

---

## 🧪 最後一層驗證仍然要回到使用者操作

Cloud Run health 與 LINE Verify 能證明 webhook 可達，卻不會替使用者點「換一批」。

真正的操作路徑仍然是：

1. 在 Zona Cafe 傳任意文字
2. 分享目前位置
3. 等待咖啡廳推薦
4. 點「換一批」
5. 確認出現不同結果
6. 點「更適合工作」

Codex 完成的是讓這條路徑安全地進入正式環境，並確保入口切換失敗時不會失去舊版 Bot。

---

## 🏆 第四篇總結：發布策略也是功能的一部分

今天 Codex 沒有只交付一個新的 Cloud Run URL。

它安排了一條可回復路徑：

- 新 repo 承接完整可部署版本
- 新舊 Cloud Run service 平行存在
- 新服務使用獨立 runtime 身分
- 切換前先做健康與錯誤檢查
- 從 LINE API 讀取真正的舊 endpoint
- 更新後立即 Verify
- 失敗自動回復舊 endpoint

這些步驟不會讓「換一批」按鈕看起來更漂亮，卻決定新功能上線時會不會拖累原本可用的服務。

我今天從 Codex 學到的是：

> 發布不是把新版推上去，而是先知道怎麼安全地回來。

---

### 📂 本篇完整程式碼

https://github.com/zonawang/codex-postback-action
