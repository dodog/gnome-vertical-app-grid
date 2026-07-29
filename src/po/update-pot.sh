#!/bin/bash
set -e
cd "$(dirname "$0")/.."

xgettext \
  --from-code=UTF-8 \
  --keyword=_ --keyword=N_ --keyword=C_:1c,2 \
  --keyword=ngettext:1,2 --keyword=gettext \
  --package-name="vertigrid" \
  --package-version="1.0" \
  --msgid-bugs-address="https://github.com/dodog/vertigrid/issues" \
  --output=po/js-strings.pot \
  extension.js categories.js appDisplay.js prefs.js

xgettext \
  --from-code=UTF-8 \
  --output=po/ui-strings.pot \
  prefs.ui

msgcat --use-first -o po/vertigrid.pot po/js-strings.pot po/ui-strings.pot
rm po/js-strings.pot po/ui-strings.pot

echo "Extracted $(grep -c '^msgid' po/vertigrid.pot) strings."

for po_file in po/*.po; do
    [ -e "$po_file" ] || continue
    msgmerge --update --backup=off "$po_file" po/vertigrid.pot
    echo "Updated $po_file"
done