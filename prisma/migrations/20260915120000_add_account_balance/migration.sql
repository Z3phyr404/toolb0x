-- Tatsächlicher Kontostand als vom Nutzer gepflegter Schnappschuss.
-- "Verbleibend" (Einnahmen - Ausgaben der Periode) beantwortet nicht, wie
-- viel Geld wirklich auf dem Konto liegt: wiederkehrende Ausgaben stehen zum
-- Monatsanfang schon in voller Höhe drin, Überträge aus Vormonaten fehlen
-- ganz. Deshalb ein eigener, manuell gepflegter Wert.
--
-- accountBalance ist verschlüsselt (AES-256-GCM) und daher TEXT, nicht NUMERIC
-- — wie jeder andere Betrag in diesem Schema.
-- accountBalanceAt bleibt Klartext: nur der Zeitpunkt der Eingabe, damit die
-- App einen veralteten Stand als solchen kennzeichnen kann.
ALTER TABLE "users" ADD COLUMN "accountBalance" TEXT;
ALTER TABLE "users" ADD COLUMN "accountBalanceAt" TIMESTAMP(3);
