-- Tagesdatum je Ausgabe ("YYYY-MM-DD", optional). Wie "month" bewusst
-- unverschlüsselt: reines Kalenderdatum ohne Betrags-/Namensbezug,
-- Bestandsdaten bleiben NULL (Anzeige fällt dann auf den Monat zurück).
ALTER TABLE "expenses" ADD COLUMN "spentOn" TEXT;
