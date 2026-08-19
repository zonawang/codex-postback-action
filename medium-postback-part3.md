# 我不敢直接把 LINE Webhook 指向新版：先寫好失敗時怎麼切回去

上一個系列裡，我處理過 Webhook 收到事件後，怎麼讓 Cloud Run 可靠地把工作做完。這次雖然又會提到 Webhook，但問題不太一樣：**正式 LINE Bot 要從舊版切到新版時，如果新版有問題，怎麼馬上切回去？**

Postback 功能在本機完成，也通過測試了。我原本可以直接更新現有服務，但這樣做有點像一邊營業、一邊拆店面。新版只要少一個環境變數或權限，原本正常的功能也會一起消失。

所以我和 Codex 先把「怎麼回去」寫進發布流程：舊服務保持運作，新服務平行上線；確認新服務正常後才切換 LINE Webhook，失敗就立刻換回舊網址。

---

## 先讓新舊版本並存，不急著替換

這次的 Postback 功能放在新的 repo 和 Cloud Run service：

```text
舊服務：line-map-grounding
新服務：codex-postback-action
```

舊服務保持不動，繼續當作目前已知可用的版本。新服務則可以先部署、檢查和修正，不會立刻影響 LINE 使用者。

這不是打算長期維護兩套 Bot，而是讓發布當下有兩個清楚的選項：新版沒問題就切過去；有問題就回到舊版。

Postback 新增了 Firestore session，因此新服務也使用自己的 runtime service account，只拿 Vertex AI、Firestore 與服務用量所需的權限。新版有獨立身分，真的出問題時也能單獨停用，不影響舊服務。

---

## 新服務先站穩，再讓 LINE 使用者進來

Cloud Run 顯示部署成功後，我們沒有馬上修改 LINE 設定，而是先打開新服務的 `/health`、查看啟動 logs，並確認 Firestore 與必要 API 都準備好了。舊服務網址也要繼續可用，因為那就是等一下出問題時要回去的地方。

這些檢查不算正式上線，只是在切換前先排除容器起不來、環境變數漏設或服務入口寫錯等問題。

---

## 不靠記憶，先向 LINE 讀取真正的舊網址

真正修改 Webhook 前，Codex 先透過 LINE API 讀取目前使用中的 endpoint，而不是靠我手動貼一個印象中的舊網址。

原因很簡單：正式設定可能曾經被改過。我印象中的舊網址，不一定是 LINE 現在真的在用的網址。要準備 rollback，就應該以 LINE API 當下回傳的值為準。

接著流程是：

```text
讀取目前的舊 endpoint
  → 設定新的 endpoint
  → 執行 LINE Webhook Verify
  → 成功就保留新版
  → 失敗就切回舊版
```

概念程式如下：

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

這次 Verify 回傳 `200 OK`，新服務 logs 也沒有 error，Webhook 才正式留在新網址。如果 Verify 回傳失敗，或中途任何 API 呼叫拋出錯誤，程式都會把 endpoint 設回剛才讀到的舊值。

真正讓我安心的不是 Verify 成功，而是失敗時該做什麼，早在切換前就已經寫好了。

---

## 看到 `PROCESSING`，要先問它會不會影響使用者

部署當下，Firestore TTL 還顯示為 `PROCESSING`。

第一眼看到這個狀態，很容易覺得是不是不該切換。但 session 是否過期，本來就是由程式即時檢查；TTL 只負責稍後清除舊資料，不會影響使用者能不能按「換一批」。

所以我們沒有因為 TTL 還在背景處理就回復舊版。

可回復發布不是看到任何非同步狀態就立刻撤退，而是要先分清楚：它會不會真的影響現在的使用者？

---

## Verify 成功後，最後再用手機確認

最後我還是拿起手機，傳送位置、點「換一批」，再試一次「更適合工作」。Cloud Run health 和 Webhook Verify 只能證明 LINE 找得到服務，不能替使用者操作新版功能。

這條路徑真的走完，新版才算上線；如果失敗，剛才保存的舊 endpoint 仍然是可以立刻回去的地方。

---

## 第三篇小結

這次發布最重要的不是多做幾項檢查，而是把回復路徑變成明確流程：保留舊服務、平行部署新版、向 LINE 讀取目前 endpoint、切換後立即 Verify，失敗就自動把舊值設回去。

這些步驟不會讓「換一批」按鈕更漂亮，卻能避免新功能上線時，把原本正常的 Bot 一起拖下水。它也和先前的 Webhook lifecycle 文章不同：那一篇確保事件進來後能做完，這一篇確保入口切錯時能回來。

我這次最想留下的一句話是：

> 發布不是把新版推上去，而是先知道出問題時要怎麼安全地回來。

---

### 本篇完整程式碼

https://github.com/zonawang/codex-postback-action
