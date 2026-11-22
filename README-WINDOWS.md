# Наш дом — Windows-приложение

Это Electron-оболочка для семейного органайзера. Приложение хранит задачи в профиле пользователя и умеет синхронизировать их между двумя установками в одной домашней сети.

## Синхронизация через Firebase

Firebase позволяет обоим пользователям работать через интернет без постоянно включённого домашнего ПК. На обеих установках в разделе **Настройки** укажите один и тот же `Project ID` и `Web API key`, а затем войдите под своей учётной записью Firebase. Эти значения сохраняются на конкретном компьютере; пароль приложение не хранит.

### Однократная настройка Firebase

1. В [Firebase Console](https://console.firebase.google.com/) создайте проект и добавьте Web app.
2. В **Build → Firestore Database** создайте базу в production mode, выбрав ближайший регион. Регион позже изменить нельзя.
3. В **Build → Authentication → Sign-in method** включите **Email/Password**.
4. Во вкладке **Users** создайте две учётные записи — по одной для каждого пользователя.
5. В **Firestore Database → Rules** замените правила на код ниже, подставив оба e-mail, и опубликуйте изменения:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /our-home/shared {
      allow read, write: if request.auth != null
        && (request.auth.token.email == "first@example.com"
            || request.auth.token.email == "second@example.com");
    }
  }
}
```

6. В **Project settings → General → Your apps** скопируйте из конфигурации Web app значения `apiKey` и `projectId`. Не передавайте и не добавляйте в приложение JSON-ключ сервисного аккаунта.

После первого входа приложение переносит текущий локальный список в общий документ Firebase. Изменения отправляются сразу после действия и проверяются каждые 15 секунд. Для синхронизации нужен интернет, но второй компьютер не зависит от работы первого.

## Локальный запуск

```powershell
npm install
npm run desktop:dev
```

## Создание установщика Windows

```powershell
npm run desktop:build
```

После успешной сборки NSIS-установщик появится в `outputs/our-home-windows/`.

Установщик создаёт ярлыки в меню «Пуск» и на рабочем столе. Для публикации потребуется кодовая подпись, которой в текущем прототипе нет.
