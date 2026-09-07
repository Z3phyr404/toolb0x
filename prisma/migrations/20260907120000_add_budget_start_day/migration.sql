-- Verschiebbarer Monatsanfang: Wer sein Geld am 15. bekommt, rechnet vom
-- 15. bis zum 14. des Folgemonats. Der DB-Schlüssel "month" (YYYY-MM) bleibt
-- unverändert — die Periode heisst nach dem Monat, in dem sie BEGINNT.
-- Gültige Werte 1-28 (ab 29 gäbe es Monate ohne diesen Tag); die Prüfung
-- passiert in der Anwendung, Default 1 = bisheriges Verhalten.
ALTER TABLE "users" ADD COLUMN "budgetStartDay" INTEGER NOT NULL DEFAULT 1;
