# Energie-Dashboard Analytics (Tablet) für Home Assistant

Eine Lovelace Custom Card, die die Daten des **eingebauten Home-Assistant-Energie-Dashboards** als großes Analytics-Dashboard im Tablet-Format darstellt — inspiriert von der Anker-SOLIX-App.

Die Karte liest die **Langzeit-Statistiken des Recorders** (dieselben Daten, die auch das HA-Energie-Dashboard anzeigt). Es sind **keine zusätzlichen Sensoren, Helfer oder Integrationen** nötig — konfiguriert wird alles über das normale Energie-Dashboard von Home Assistant.

## Funktionen

- **Automatische Quellen-Erkennung**: Solar, Netz (Bezug/Einspeisung), Speicher (Laden/Entladen) und alle Verbraucher-Geräte werden automatisch aus der Energie-Dashboard-Konfiguration übernommen. Neue Steckdosen/Geräte erscheinen ohne Anpassung der Karte.
- **6 Stat-Kacheln**: Gesamtertrag (€ + ROI), Solarproduktion, Hausverbrauch, Autarkiequote, CO₂-Einsparung, Rekorde
- **Zeitraum-Ansichten**: Tag / Woche / Monat / Jahr / Alle, mit Zeit-Slider (14 Datenpunkte pro Ansicht)
- **6 Tabs**:
  - 📊 **Übersicht** — Energiefluss, Verbrauchs-Verteilung (Donut), Autarkie & Eigenverbrauch, Ertragsübersicht in €
  - 🔌 **Geräte** — gestapelter Geräteverbrauch im Zeitverlauf, Top-Verbraucher, gemessen vs. nicht gemessen
  - 🔋 **Speicher** — Laden/Entladen, Speicher-Effizienz, Netzbezug vs. Einspeisung
  - 🌿 **CO₂** — CO₂-Einsparung (0,363 kg/kWh genutzter Solarenergie)
  - 📅 **Heatmap** — Produktions-Kalender mit Markierung des besten Tages
  - 📋 **Tabelle** — alle Tageswerte im Detail
- **ROI-Einstellungen** direkt in der Karte: Strompreis, Einspeisevergütung, Anlagenkosten
- Optimiert für **Tablet-/Panel-Ansicht** (3-Spalten-Grid), responsive bis Smartphone
- Unterstützt helle und dunkle HA-Themes (nutzt die Theme-Variablen)

## Voraussetzungen

- Home Assistant mit konfiguriertem **Energie-Dashboard** (Einstellungen → Dashboards → Energie): mindestens Netz und/oder Solar müssen eingerichtet sein. Geräteverbrauch (einzelne Steckdosen) ist optional.
- Internetzugriff des Browsers auf `cdn.jsdelivr.net` (Chart.js wird von dort geladen).

## Installation

### Variante A: HACS (empfohlen)

1. HACS → drei Punkte oben rechts → **Benutzerdefinierte Repositories**
2. Repository-URL dieses Repos eintragen, Typ: **Dashboard** (Lovelace)
3. Die Karte **„Energie-Dashboard Analytics (Tablet)"** suchen und herunterladen
4. HACS registriert die Ressource automatisch. Danach Browser-Cache leeren (`Strg+Shift+R`).

### Variante B: Manuell

1. Die Datei [`energy-dashboard-card-tablet.js`](energy-dashboard-card-tablet.js) herunterladen und nach
   `/config/www/energy-dashboard-card/energy-dashboard-card-tablet.js` kopieren
   (z. B. per Samba-Add-on, File editor oder SSH).
2. Ressource registrieren: **Einstellungen → Dashboards → drei Punkte oben rechts → Ressourcen → Ressource hinzufügen**
   - URL: `/local/energy-dashboard-card/energy-dashboard-card-tablet.js`
   - Typ: **JavaScript-Modul**

   > Der Menüpunkt „Ressourcen" erscheint nur, wenn der **erweiterte Modus** im eigenen Benutzerprofil aktiviert ist.
3. Browser-Cache leeren (`Strg+Shift+R`).

### Dashboard anlegen

Am besten wirkt die Karte in einem eigenen Dashboard mit **Panel-Ansicht** (Karte füllt die ganze Breite):

1. **Einstellungen → Dashboards → Dashboard hinzufügen** → „Neues Dashboard von Grund auf"
2. Im neuen Dashboard: Bearbeiten → Ansicht bearbeiten → Ansichtstyp **Panel**
3. Karte hinzufügen → **Manuell** und eintragen:

```yaml
type: custom:energy-dashboard-card-tablet
```

Fertig — die Karte findet alle Datenquellen selbst.

## Konfiguration (optional)

Ohne weitere Angaben nutzt die Karte automatisch die Quellen des Energie-Dashboards. Alle Optionen:

```yaml
type: custom:energy-dashboard-card-tablet

# Zeitraum & Tarife
days: 365                 # wie viele Tage Historie geladen werden (Standard: 365)
energy_price: 0.35        # Strompreis €/kWh (Standard: 0.35)
feed_in_tariff: 0.082     # Einspeisevergütung €/kWh (Standard: 0.082)
system_cost: 1200         # Anlagenkosten in € für die ROI-Berechnung (Standard: 1200)

# Geräte aus der Anzeige ausblenden (bleiben im HA-Energie-Dashboard erhalten)
exclude_devices:
  - sensor.poolpumpe_energie_gesamt

# ODER die automatische Geräteliste komplett ersetzen
devices:
  - entity: sensor.kuche_energie_gesamt
    name: Küche
  - entity: sensor.waschmaschine_energie_gesamt
    name: Waschmaschine

# Energie-Quellen manuell übersteuern (jeweils einzelner Sensor oder Liste)
solar_sensor: sensor.meine_solarproduktion
grid_import_sensor: sensor.mein_netzbezug
grid_export_sensor: sensor.meine_einspeisung
battery_in_sensor: sensor.speicher_ladung
battery_out_sensor: sensor.speicher_entladung
```

| Option | Typ | Standard | Beschreibung |
|---|---|---|---|
| `days` | Zahl | `365` | Geladene Historie in Tagen |
| `energy_price` | Zahl | `0.35` | Strompreis in €/kWh (auch in der Karte änderbar) |
| `feed_in_tariff` | Zahl | `0.082` | Einspeisevergütung in €/kWh |
| `system_cost` | Zahl | `1200` | Anlagenkosten in € (ROI) |
| `exclude_devices` | Liste | – | Entity-IDs, die ausgeblendet werden |
| `devices` | Liste | automatisch | Ersetzt die automatische Geräteliste (`entity` + optional `name`) |
| `solar_sensor` … `battery_out_sensor` | String/Liste | automatisch | Übersteuert die jeweilige Energie-Quelle |

## Berechnungsgrundlagen

- **Hausverbrauch** = Netzbezug + Solar + Speicher-Entladung − Speicher-Ladung − Einspeisung
- **Autarkiequote** = (Hausverbrauch − Netzbezug) / Hausverbrauch
- **EV-Quote** (Eigenverbrauchsquote) = genutzte Solarenergie / Erzeugung
- **Ersparnis** = direkt verbrauchte Energie × Strompreis; **Einspeise-Erlös** = Einspeisung × Vergütung
- **CO₂-Einsparung** = genutzte Solarenergie × 0,363 kg/kWh

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Benutzerdefiniertes Element existiert nicht" | Ressource korrekt registriert? Browser-Cache leeren (`Strg+Shift+R`). |
| „Keine Energie-Quellen gefunden" | Energie-Dashboard in HA konfigurieren (Einstellungen → Dashboards → Energie) oder Sensoren in der Karten-Konfiguration angeben. |
| Karte lädt endlos / Chart-Fehler | Browser braucht Zugriff auf `cdn.jsdelivr.net` (Chart.js). |
| Werte weichen vom HA-Energie-Dashboard ab | Die Karte nutzt Tages-Statistiken; der laufende (heutige) Tag ist erst nach der nächsten Statistik-Aktualisierung (stündlich) vollständig. |

## Lizenz

[MIT](LICENSE)
