# language: de
@url:https://www.saucedemo.com/
Funktionalität: Sauce Demo auf Deutsch

  Szenario: Ein gesperrter Benutzer kann sich nicht anmelden
    Wenn ich versuche, mich als "locked_out_user" mit dem Passwort "secret_sauce" anzumelden
    Dann sollte der Fehler "Sorry, this user has been locked out." lauten

  Szenario: Nach Preis sortieren zeigt das günstigste Produkt zuerst
    Wenn ich mich als "standard_user" mit dem Passwort "secret_sauce" anmelde
    Und ich die Produkte nach "Price (low to high)" sortiere
    Dann sollte der erste Produktpreis "$7.99" sein

  Szenario: Der Warenkorb zählt hinzugefügte Produkte
    Wenn ich mich als "standard_user" mit dem Passwort "secret_sauce" anmelde
    Und ich "Sauce Labs Backpack" in den Warenkorb lege
    Und ich "Sauce Labs Bike Light" in den Warenkorb lege
    Dann sollte das Warenkorb-Symbol "2" anzeigen

  Szenario: Kasse verlangt einen Vornamen, dann wird bestellt
    Wenn ich mich als "standard_user" mit dem Passwort "secret_sauce" anmelde
    Und ich "Sauce Labs Backpack" in den Warenkorb lege
    Und ich den Warenkorb öffne
    Und ich zur Kasse gehe
    Und ich versuche fortzufahren, ohne das Formular auszufüllen
    Dann sollte der Fehler "First Name is required" lauten
    Wenn ich "Ada" als Vorname, "Lovelace" als Nachname und "10115" als Postleitzahl eingebe
    Und ich fortfahre
    Dann sollte die Zwischensumme "$29.99" sein
    Wenn ich die Bestellung abschließe
    Dann sollte ich "Thank you for your order!" sehen
