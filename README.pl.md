# M-HUB

Aplikacja desktopowa na Windows: wiele kont komunikatorów w jednym oknie, każde w izolowanej
sesji, plus makra tekstowe z załącznikami. WhatsApp, Messenger, LinkedIn i Facebook, bez limitu
liczby kont.

Interfejs po **polsku** i **angielsku**. Domyślny jest angielski – polski wybierzesz
w Ustawieniach.

**[English version of this README](README.md)**

Zbudowałem ją dla siebie: potrzebowałem kilku kont obok siebie, każdego w osobnej sesji –
i udostępniam ją, bo ten problem nie jest tylko mój. Jest darmowa i taka zostanie.

Jest darmową alternatywą dla płatnej aplikacji **All-in-One Messenger Hub**, która od
2026-07-18 wymaga licencji Pro do drugiego konta WhatsApp. Audyt tamtej aplikacji (sekcja 1
specu) wykazał dwa powody, żeby jej nie kupować: nieosiągalny podmiot odpowiedzialny za dane
oraz `wppconnect-wa.js` na pokładzie, czyli bibliotekę ingerującą w wewnętrzne funkcje
WhatsApp Web – a to grozi trwałą blokadą numeru.

## Instalacja

Instalator leży w [Releases](https://github.com/mkencki/m-hub/releases). Każde wydanie niesie
sumę SHA256 swojego instalatora, a to, kto podpisuje pliki i co aplikacja robi z danymi, opisuje
[polityka podpisywania kodu](docs/code-signing-policy.md).

> **Instalator nie jest podpisany cyfrowo.** Windows ostrzeże, a na czystej instalacji
> Windows 11 **Smart App Control zablokuje go całkiem**. Przeczytaj
> **[docs/installing.md](docs/installing.md)** – tłumaczy, którą z dwóch
> reakcji właśnie widzisz i co z każdą zrobić.

Jest to w toku: M-HUB ubiega się w [SignPath Foundation](https://signpath.org/) o darmowe
podpisywanie kodu, które fundacja oferuje projektom open source. Dopóki wniosek nie zostanie
rozpatrzony, wydania pozostają niepodpisane.

Uruchomienie ze źródeł działa nawet przy włączonym Smart App Control:

```bash
npm install
npm start
```

Repozytorium zmieniło nazwę na `m-hub` 2026-09-02, żeby zgadzała się z nazwą aplikacji.
GitHub trzyma trwałe przekierowania, więc odnośniki opublikowane pod `mkencki/msg-hub` – w tym
linki do plików w starszych wydaniach – nadal działają. Nie przekierowują się dwie rzeczy:
witryny GitHub Pages i akcje hostowane w repozytorium, a tych projekt nie ma. Starej nazwy nie
wolno użyć ponownie dla innego repozytorium, bo to zerwałoby przekierowania.

### Ikona na pasku zadań

Windows bierze ikonę i nazwę przypiętego przycisku ze **skrótu**, a nie z działającego okna.
Przypięcie aplikacji uruchomionej przez `npm start` przypina `electron.exe` – razem z logo
Electrona. Jedno polecenie zakłada skrót w menu Start, który niesie ikonę M-HUB-a i jego
tożsamość aplikacji, więc żywe okno wchodzi w przypięty przycisk zamiast stawać obok niego:

```bash
npm run shortcut
```

Potem przypnij **M-HUB** z menu Start i odepnij starszy przycisk „Electron”. Wersja
zainstalowana tego nie potrzebuje – jej instalator zakłada taki sam skrót.

## Co robi

| | |
|---|---|
| **Konta** | dowolnie wiele, każde w partycji `persist:<id>` – pełna izolacja ciasteczek, `localStorage` i `IndexedDB` |
| **Szyna kanałów** | zwijana do samych kolorów kanałów, rozwija się na najazd kursora, przypinana na stałe; licznik nowych przy każdym koncie |
| **Ustawienia** | zarządzanie kontami: dodanie, zmiana nazwy i koloru, kolejność zakładek, usunięcie wraz z czyszczeniem sesji |
| **Makra** | `Ctrl+;` – paleta z wyszukiwarką, wyborem strzałkami i Enterem; edycja i usuwanie za potwierdzeniem |
| **Edytor makra** | pasek formatowania WhatsApp, podgląd na żywo, dodawanie i zdejmowanie załączników, tagi |
| **Zmienne** | wpisz `{imię}` w makrze, a apka zapyta o wartość przed wstawieniem; `{data}` uzupełnia się sama |
| **Załączniki** | PDF i mp4 **kopiowane do magazynu aplikacji** – oryginalny plik przestaje być potrzebny; limit 100 MB |
| **Język** | angielski i polski, przełączany w Ustawieniach bez restartu; wybór przeżywa restart |
| **Klawiatura** | `Ctrl+1`..`Ctrl+9` skaczą do kanału, `Ctrl+;` otwiera makra, `Ctrl+Shift+Space` robi to z dowolnego programu, `Ctrl+R` przeładowuje oglądane konto |
| **Zasobnik** | zamknięcie okna zostawia apkę żywą i czuwającą; można to wyłączyć w Ustawieniach. Autostart naprawdę startuje ukryty |
| **Odzyskiwanie** | konto, które padło, zawisło albo się zdezaktualizowało, proponuje przeładowanie w pasku statusu – nic nie przeładowuje się samo, bo to skasowałoby na wpół napisaną wiadomość |
| **Linki** | link z rozmowy otwiera się w twojej przeglądarce, a nie w oknie bez paska adresu, niosącym twoją zalogowaną sesję |
| **Pobieranie** | plik z rozmowy melduje, że się zapisał, i podaje odnośnik do folderu; w Ustawieniach jest folder pobierania i przełącznik „pytaj za każdym razem” |
| **O aplikacji** | tabliczka na dole Ustawień: wersja, data i commit budowy, Electron i Chromium, folder profilu z rozmiarem na dysku i przyciskiem, który go otwiera, licencja i kod źródłowy |

Makra i załączniki żyją w `%APPDATA%\M-HUB` (`macros.json` oraz katalog `att/`),
konta w `accounts.json` obok nich. Usunięcie makra albo zdjęcie załącznika sprząta
magazyn, żeby kilkumegabajtowe wideo nie zostawało na dysku bez właściciela.

Zmiana nazwy konta **nie rusza jego identyfikatora**, bo na identyfikatorze stoi
partycja sesji (`persist:<id>`) – poprawka literówki nie wylogowuje konta.

## Serwisy

| | |
|---|---|
| **WhatsApp** | dowolnie wiele kont, każde z własnym logowaniem |
| **Messenger** | messenger.com |
| **LinkedIn** | cały serwis – feed, oferty, learning, wiadomości – a nie sama skrzynka |
| **Facebook** | cały serwis |

Facebook i Messenger to **osobne konta z osobnym logowaniem**, nawet dla jednej tożsamości
Mety, bo każde konto ma własną sesję. Zalogowanie się do obu oznacza dwa logowania i – na
koncie Mety – możliwe dwa przeglądy bezpieczeństwa.

**Licznik pokazujemy tylko tam, gdzie serwis podaje go w tytule strony** i tylko tam, gdzie
ta liczba znaczy to, co licznik przy kanale ma znaczyć: czekające rozmowy. WhatsApp
i Messenger tak mają. Liczba LinkedIna to suma ośmiu różnych odznak – feed, oferty,
powiadomienia, wiadomości – więc nie pokazuje żadnej; formatu Facebooka nie udało się
potwierdzić, więc też nie. Nic tutaj nie czyta zawartości stron, żeby to ustalić.

**Powiadomienia są per konto.** Komunikatory mogą przerywać od razu; LinkedIn i Facebook
milczą, dopóki im nie pozwolisz w ustawieniach tego konta – bo cały serwis powiadamia
o reakcjach, grupach, stronach i urodzinach, a nie tylko o tym, że ktoś do Ciebie pisze.
Komunikator możesz uciszyć tak samo.

**Każde konto jest wczytane i pozostaje wczytane**, co kosztuje około 250 MB, gdy strona już
wstanie – zmierzone: 754 MB przy jednym koncie, 1266 MB przy trzech, 1760 MB przy pięciu. To
jest celowe: konto niewczytane nie powiadomi i niczego nie policzy, a po to ta apka istnieje.
Pięć kont chce około dwóch gigabajtów; decyduj świadomie.

> **Cofnięcie wersji kasuje nowe konta.** Build starszy niż LinkedIn i Facebook ich nie zna,
> po cichu je pomija przy czytaniu `accounts.json`, a najbliższy zapis utrwala skróconą listę.
> Po cofnięciu wersji te konta i ich logowania przepadają.

## Interfejs: konsola operatora

Aplikacja obudowuje cudzy interfejs, więc jej własne chrome jest celowo odbarwione –
jedynym nasyconym kolorem w oknie jest kolor aktywnego konta. Obrysowuje on całe okno
robocze, bo jedyne realne ryzyko tego produktu to **pomylenie tożsamości**: wysłanie
treści z prywatnego WhatsAppa do kontaktu służbowego albo odwrotnie. Formularz nowego
konta podpowiada kolor jeszcze nieużywany, żeby dwa konta nie wyglądały tak samo.

Kanały stoją w szynie po lewej, nie w zakładkach u góry: WhatsApp Web i Messenger mają
własny nagłówek, więc pasek nad paskiem tworzył wizualną papkę. Szyna zwija się do 48 px
i rozwija na najazd kursora – przycisk pinezki u góry trzyma ją rozwiniętą na stałe,
a wybór przeżywa restart. Rozwinięcie **odsuwa** widok konta zamiast go zakrywać:
widoki są natywną warstwą nad rendererem, więc nakładka narysowana w HTML schowałaby się
pod stroną komunikatora. Prawdziwa nakładka wymagałaby osobnego natywnego widoku dla szyny. Paleta makr nazywa konto
docelowe, a po wstawieniu listwa melduje, co i dokąd poszło – i przypomina, że Enter
należy do operatora.

Kroje są systemowe, **bez ani jednego zapytania do sieci**: aplikacja powstała z audytu
prywatności, więc pobieranie czcionek z cudzego serwera przy każdym starcie byłoby z nią
niespójne. Etykiety konsoli składa Bahnschrift – windowsowa pochodna DIN 1451, pisma
niemieckich znaków drogowych.

## Czego NIE robi – i nie będzie robić

Trzy granice z sekcji 7 specu. Wynikają z audytu i są nienaruszalne:

1. **Nie wysyła wiadomości.** Makro przygotowuje treść i się zatrzymuje. Enter należy
   do operatora.
2. **Nie ładuje `wa-js`, WPPConnect, Baileys ani niczego pokrewnego.** Strony ładowane
   są takie, jakie serwuje Meta.
3. **Wstawia wyłącznie przez schowek.** Bez manipulacji DOM stron, także przy załącznikach.

Reguły 1 i 2 mają egzekucję w testach – [`tests/insertion.test.js`](tests/insertion.test.js)
i [`tests/boundaries.test.js`](tests/boundaries.test.js) zapadną się, jeśli ktoś kiedyś doda
zakazaną zależność albo ścieżkę wysyłki.

### Dziennik

Aplikacja zapisuje zwykły tekstowy dziennik w `%APPDATA%\M-HUB\logs\`, dostępny z menu
w zasobniku. Istnieje po to, żeby pomoc komuś, komu apka nie chce się zalogować, nie wymagała
siadania przy jego komputerze.

**Zapisuje rodzaje zdarzeń i kody błędów – i nic poza tym.** Żadnej treści wiadomości, żadnej
treści makr, żadnych nazw załączników, tytułów stron ani nazw rozmów. Konto występuje pod swoim
identyfikatorem, nigdy pod nazwą, którą mu nadałeś – ta nazwa to bardzo często czyjeś imię.
To nie jest obietnica co do sposobu pisania kodu: `src/main/log.js` zapisuje wyłącznie pola
z krótkiej zadeklarowanej listy i po cichu odrzuca całą resztę, a
[`tests/log.test.js`](tests/log.test.js) padnie, jeśli ta lista urośnie bez czyjejś decyzji.

Plik ma twardy limit rozmiaru i rotację z zachowaniem najwyżej jednej starszej kopii, więc nie
zapełni dysku. Dziennik, który możesz przeczytać i świadomie wysłać, jest przeciwieństwem
telemetrii.

## Dokumentacja

- [`docs/typography.md`](docs/typography.md)
  – znaki, których używają oba języki, i test, który tego pilnuje
- [`docs/design.md`](docs/design.md)
  – projekt: audyt, architektura, model danych, granice bezpieczeństwa, odrzucone warianty

## Testy

```bash
npm test          # Vitest – logika
npm run test:e2e  # Playwright + Electron – ścieżki operatora na prawdziwym oknie
npm run dist      # przenośny .exe (buduje się lokalnie)
```

**Instalator** buduje [CI](.github/workflows/build.yml), nie maszyna lokalna: NSIS generuje
deinstalator, URUCHAMIAJĄC świeżo zbudowany instalator, a Smart App Control to ubija. Runner
GitHuba nie ma SAC, więc `npm run dist:installer` należy do niego.

Test paczki pomija się sam, ale **na zmierzonej próbie uruchomienia**, nie na odczycie rejestru –
wcześniej milczał zawsze, gdy SAC był włączony, także wtedy, gdy paczka działała.

Teksty interfejsu siedzą w [`src/shared/locales/`](src/shared/locales/) pod kluczami, nie
w kodzie. Test jednostkowy czerwieni się, gdy słowniki się rozjadą – inaczej nowy napis trafiłby
do jednego języka, a drugi pokazywałby goły klucz dopiero u użytkownika.

## Znane ograniczenia środowiska

**Smart App Control blokuje własny `.exe`.** Na `hp-x360-win` polityka jest włączona
(`VerifiedAndReputablePolicyState = 0x1`) i odmawia uruchomienia świeżo zbudowanej paczki:
„An Application Control policy has blocked this file”. Dotyczy to i `dist/win-unpacked`,
i przenośnego `.exe`. `electron.exe` startuje bez przeszkód – jest równie niepodpisany,
ale ma reputację w chmurze Microsoftu, której unikatowy własny build mieć nie może.

Pomiary z 2026-08-24, bo temat kusi do złych wniosków:

| Próba | Wynik |
|---|---|
| paczka sprzed ~20 h, bez znacznika MotW | **działa** |
| ta sama paczka przebudowana przed chwilą | **zablokowana** |
| kopia w `Downloads` ze znacznikiem `ZoneId=3` | **zablokowana** |
| ta kopia po `Unblock-File` (znacznik zdjęty) | **dalej zablokowana** |

Zmienną nie jest więc Mark of the Web, tylko **reputacja**: świeży plik żadnej nie ma, a raz
zapadła blokada nie cofa się po zdjęciu znacznika. Wniosek „znajomy odblokuje plik prawoklikiem”
jest **fałszywy** – sprawdzony i obalony. Jedynym realnym wyjściem jest certyfikat do podpisu
kodu; do czasu jego zakupu instalator działa wyłącznie tam, gdzie SAC jest wyłączony.

**Wstawianie plików idzie przez Windows PowerShell 5.1.** `Set-Clipboard -LiteralPath`
i `Get-Clipboard -Format` **nie istnieją w PowerShell 7** – stąd jawne `powershell.exe`,
nigdy `pwsh`. Aplikacja trzyma jedną sesję PowerShella przez cały czas pracy: wstawienie
pliku kosztuje wtedy 15 ms zamiast 668 ms na proces jednorazowy.

## Stack

Node 26, Electron 43, czysty JavaScript ESM bez bundlera. Vitest, Playwright, electron-builder.

**Kod jest po angielsku** – nazwy plików, identyfikatory, komentarze, klucze JSON i opisy testów.
Nie zawsze tak było: aplikacja zaczęła jako prywatne narzędzie pisane po polsku i wersja 1 formatu
na dysku nadal ma polskie klucze. Odczyt przyjmuje obie pisownie, a najbliższy zapis odkłada
wersję 2 – aktualizacja nie kosztuje nikogo kont ani makr. Pilnuje tego
[`tests/migration.test.js`](tests/migration.test.js).

## Licencja

[MIT](LICENSE) © 2026 Marek Kencki
