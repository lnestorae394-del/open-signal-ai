# Первый push в GitHub (когда будете готовы)

Выполняется только с вашего решения. Репозиторий должен быть **приватным** и **новым**, не связанным с другими проектами.

## 1. Создать пустой репозиторий
1. Откройте https://github.com/new.
2. В поле **Repository name** введите `open-signal-ai`.
3. Выберите **Private**.
4. **Не** ставьте галочки README, .gitignore и license: они уже есть в проекте.
5. Нажмите **Create repository**.

## 2. Проверить, что секреты не попадут в git
В папке проекта выполните:
```bash
git init
git add .
git status
```
В списке **не должно быть** `.env`, `.data/`, `node_modules/` или файлов `*firebase-adminsdk*.json`. Если что-то из этого есть, остановитесь и не продолжайте.

## 3. Первый коммит и push
Адрес замените на свой (он показан на странице нового репозитория):
```bash
git commit -m "OPEN SIGNAL AI — stage 1 foundation"
git branch -M main
git remote add origin https://github.com/<ВАШ_ЛОГИН>/open-signal-ai.git
git push -u origin main
```
При первом push GitHub попросит войти. Используйте окно входа GitHub, пароли в терминал не вставляйте.
