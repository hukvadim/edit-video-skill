# edit-video — скіл Claude Code для монтажу Reels / TikTok / Shorts

Кладете сире відео «говорю в камеру» в папку, пишете Claude `/edit-video VID.mp4` і отримуєте готовий
вертикальний ролик 1080×1920:

- вирізані паузи, «еее», дублі; наближення на склейках ховає джамп-кати;
- чистий звук: шумодав, компресор, −14 LUFS, без клацань на склейках;
- субтитри по 2–3 слова, поточне слово підсвічене жовтим;
- титул-хук і плашки з ключовими думками;
- **ваші роботи вилітають за спиною**: картки в рамці браузера (Remotion, пружини, паралакс, 3D-стіна),
  а ви на передньому плані завдяки масці Robust Video Matting, без зеленого екрана;
- повноекранні стокові вставки з переходом і звуком «вжух»;
- фонова музика, яка приглушується під голосом.

**Два формати запису:**
1. **Говорюща голова** — одне відео.
2. **Екран + голова + окремий мікрофон** (`… Head.mp4`, `… Screen.mp4`, `… Sound.wav` в одній папці) →
   `/edit-video <папка>`. Скіл сам синхронізує файли за звуком і складає спліт: екран зверху з наближенням на
   потрібну ділянку, ви знизу, звук із мікрофона.

Як має виглядати ролик (структура, темп, стиль, звук, чекліст), описано в [docs/TZ-video.md](docs/TZ-video.md).

## Встановлення

Потрібні [Claude Code](https://claude.com/claude-code) і git. Решту скіл поставить сам при першому запуску.

**Windows (PowerShell):**
```powershell
git clone https://github.com/hukvadim/edit-video-skill "$env:USERPROFILE\.claude\skills\edit-video"
```

**macOS:**
```bash
git clone https://github.com/hukvadim/edit-video-skill ~/.claude/skills/edit-video
```

Відкрийте Claude Code у папці з відео й напишіть:
```
/edit-video VID_20260608_165802.mp4
```

### Що встановлюється при першому запуску (`scripts/setup.mjs`)
| Компонент | Windows | macOS | Розмір |
|---|---|---|---|
| Node.js ≥ 20 | `winget install OpenJS.NodeJS.LTS` | `brew install node` | — |
| ffmpeg ≥ 7 (libass) | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | ~200 МБ |
| whisper.cpp | реліз `whisper-bin-x64.zip` з GitHub | `brew install whisper-cpp` | ~10 МБ |
| модель whisper large-v3-turbo q5 | huggingface | так само | ~570 МБ |
| модель RVM mobilenetv3 | GitHub releases | так само | 15 МБ |
| Remotion, onnxruntime-node, React | `npm ci` | так само | ~300 МБ |
| Chrome Headless Shell (для Remotion) | автоматично | так само | ~120 МБ |

Перевірити або доставити вручну:
```
node ~/.claude/skills/edit-video/scripts/setup.mjs          # перевірити й встановити відсутнє
node ~/.claude/skills/edit-video/scripts/setup.mjs --check  # лише звіт
```
На Windows зі старим Visual C++ Runtime setup сам підкладе новіші DLL для onnxruntime (система не змінюється),
а якщо це не допоможе — поставить VC++ Redistributable (з'явиться вікно UAC).

> macOS-гілку (Homebrew, шрифт Montserrat) написано, але на Mac не перевірено. Якщо щось не так, напишіть в Issues.

## Структура папки з відео
```
мій-ролик/
  VID.mp4
  assets/covers/   — обкладинки/скріншоти ваших робіт для b-roll (16:9)
  assets/stock/    — стокові кліпи для вставок
  assets/music/    — фонова музика
  assets/sfx/      — (необов'язково) свій «вжух»
  work/VID/        — розшифровка, edit.json, кеш маски й кліпів, прев'ю
  out/VID_final.mp4
```

## Команди (Claude запускає їх сам)
```
node scripts/vid.mjs prep <відео|папка> [uk|ru|en|auto] [--audio f] [--screen f]   # розшифровка, паузи, синхронізація
node scripts/vid.mjs preview work/<назва>/edit.json  # прев'ю 540×960 + тестові кадри
node scripts/vid.mjs render  work/<назва>/edit.json  # фінал 1080×1920
node scripts/vid.mjs selftest
```
Приклад плану монтажу: [examples/edit.example.json](examples/edit.example.json).

## Продуктивність
На слабкому ноутбуці (i5 4-го покоління, 8 ГБ): розшифровка 80 с відео займає ~3 хв, маска ~1 кадр/с (рахується лише на
відрізках b-roll і кешується), фінальний рендер 45 с ролика — кілька хвилин.

## Ліцензії
- Код скіла — MIT ([LICENSE](LICENSE)).
- Шрифт Montserrat — SIL Open Font License ([fonts/OFL.txt](fonts/OFL.txt)).
- Стороннє скачується при встановленні, а не лежить у репозиторії: Robust Video Matting (GPL-3.0),
  whisper.cpp (MIT), Remotion ([безкоштовний для фізичних осіб і команд до 3 людей](https://remotion.dev/license)),
  ffmpeg (LGPL/GPL).
- Медіа (стоки, музика, звуки) мають власні ліцензії. Mixkit — лише кліпи з Free License; Pixabay Music — лише треки
  без позначки «Content ID Registered». Деталі в ТЗ.
