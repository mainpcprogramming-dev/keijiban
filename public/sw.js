self.addEventListener('push', function(event) {
  let data = { title: 'Quiet Board', body: '新しい通知があります', tag: 'quiet-board-default', threadId: null };
  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  // メッセージ・スレッド削除時の通知取り消し＆上書き処理
  if (data.action === 'revoke') {
    event.waitUntil(
      self.registration.getNotifications({ tag: data.tag }).then(function(notifications) {
        // 画面や通知センターに表示中の該当通知をすべて閉じる
        notifications.forEach(function(notification) {
          notification.close();
        });
        // OSの仕様上バックグラウンド受信で表示が必要な場合も、内容は「削除されました」に上書きする
        return self.registration.showNotification(data.title || 'Quiet Board', {
          body: data.body || '削除されました',
          tag: data.tag,
          renotify: false,
          silent: true,
          data: { threadId: null }
        });
      })
    );
    return;
  }

  const options = {
    body: data.body,
    tag: data.tag,
    renotify: true,
    data: { threadId: data.threadId }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const threadId = event.notification.data && event.notification.data.threadId;
  const targetUrl = threadId ? `/?thread=${threadId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});