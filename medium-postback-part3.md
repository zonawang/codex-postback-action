# 我不敢直接把 LINE Webhook 指向新版：先寫好失敗時怎麼切回去

上一個系列裡，我處理過 Webhook 收到事件後，怎麼讓 Cloud Run 可靠地把工作做完。這次雖然又要碰 Webhook，但問題換了：**正式 LINE Bot 要從舊版切到新版，萬一切過去才發現有問題，怎麼馬上回來？**

Postback 功能在本機跑通，測試也全過了。照理說，下一步就是部署，然後把 LINE Webhook 換成新網址。

但我盯著那個設定，還是有點不敢直接按下去。這樣做很像店還在營業，就直接把舊櫃台拆掉換新的。新版只要少一個環境變數或權限，原本正常的 Bot 也會一起失聯。

所以我和 Codex 沒有先問「怎麼切過去」，而是先問「切壞了怎麼回來」。最後的做法是讓舊服務繼續運作，新服務在旁邊先站好；確認沒問題才切換 LINE Webhook，失敗就立刻換回舊網址。

---

## 先讓新舊版本並存，不急著替換

這次的 Postback 功能放在新的 repo 和 Cloud Run service：

```text
舊服務：line-map-grounding
新服務：codex-postback-action
```

舊服務保持不動，繼續接住現在的使用者。新服務則可以先部署、檢查和修正，就算中間設定錯了，也不會立刻讓 LINE 聊天室一起出事。

這不是打算從此養兩套 Bot，而是在切換的那一刻，手上始終還有一個確定能用的版本。新版沒問題就往前走；有問題就先退回來。

Postback 新增了 Firestore session，因此新服務也有自己的 runtime service account，只拿 Vertex AI、Firestore 與服務用量所需的權限。新版有獨立身分，之後看 logs 比較不會混在一起，真的出問題時也能單獨停用。

---

## 新服務先站穩，再讓 LINE 使用者進來

Cloud Run 顯示部署成功時，我其實很想直接去改 LINE 設定，但我們先忍住了。

先打開新服務的 `/health`、看啟動 logs，再確認 Firestore 與必要 API 都準備好了。舊服務網址也要再測一次，因為那不是一個留著好看的備份，而是等一下真的出問題時要回去的地方。

這些檢查還不算上線，只是先把容器起不來、環境變數漏設或服務入口寫錯這類問題擋在門外。

---

## 不靠記憶，先向 LINE 讀取真正的舊網址

真正修改 Webhook 前，Codex 先透過 LINE API 讀取目前使用中的 endpoint。我原本以為把舊網址複製到旁邊備用就好，但這裡最怕的就是「我記得應該是這個」。

正式設定可能早就被改過。我印象中的舊網址，不一定是 LINE 現在真的在用的網址。既然是救援繩，就不能靠印象打結；要準備 rollback，應該以 LINE API 當下回傳的值為準。

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

這次 Verify 回傳 `200 OK`，新服務 logs 也沒有 error，Webhook 才正式留在新網址。如果 Verify 失敗，或中途任何 API 呼叫出錯，程式就會把 endpoint 設回剛才讀到的舊值。

看到 Verify 成功當然很開心，但真正讓我安心的是：就算它失敗，下一步也不用臨時查文件、手忙腳亂找舊網址。回去的路早就寫好了。

---

## 看到 `PROCESSING`，要先問它會不會影響使用者

部署當下，Firestore TTL 還顯示為 `PROCESSING`。

第一眼看到這個狀態，我心裡又停了一下：是不是還不能切？但再往下確認，session 是否過期本來就是由程式即時檢查；TTL 只負責稍後清除舊資料，不會影響使用者能不能按「換一批」。

我們因此沒有因為 TTL 還在背景處理，就把整個新版退回去。

這也讓我明白，可回復發布不是看到任何黃色燈號就立刻撤退，而是要先弄清楚：這件事現在到底會不會影響使用者？

---

## Verify 成功後，最後再用手機確認

最後我還是拿起手機，傳送位置、點「換一批」，再試一次「更適合工作」。看到真的出現另一批咖啡廳，我才稍微鬆一口氣。

Cloud Run health 和 Webhook Verify 只能證明 LINE 找得到服務，不能替使用者按下那兩顆新按鈕。

這條路徑真的走完，新版才算上線；如果失敗，剛才保存的舊 endpoint 仍然是可以立刻回去的地方。

---

## 第三篇小結

回頭看，這次其實沒有用了什麼很高深的技巧。只是把平常很容易等到出事才想的事，提前做好：舊服務先留著、新版平行部署、向 LINE 讀取目前 endpoint，切換後立刻 Verify，失敗就把舊值設回去。

這些步驟不會讓「換一批」按鈕更漂亮，卻能避免新功能上線時，把原本正常的 Bot 一起拖下水。它也和先前的 Webhook lifecycle 文章不同：那一篇確保事件進來後能做完，這一篇確保入口切錯時能回來。

我這次最想留下的一句話是：

> 發布不是把新版推上去，而是先知道出問題時要怎麼安全地回來。

---

### 本篇完整程式碼

https://github.com/zonawang/codex-postback-action
