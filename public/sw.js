self.addEventListener('push', function(event) {
  let data = { title: 'Quiet Board', body: '新しい通知があります', tag: 'quiet-board-default', threadId: null };
  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  // メッセージ・スレッド削除時の通知消去処理
  if (data.action === 'revoke') {
    event.waitUntil(
      self.registration.getNotifications({ tag: data.tag }).then(function(notifications) {
        notifications.forEach(function(notification) {
          notification.close();
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