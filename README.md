# UBHD 3D Recipes

Dieses Plugin stellt FYLR/FAS-Rezepte bereit, um 3D-Uploads in webtaugliche Derivate fuer den UBHD-Viewer umzuwandeln.

Aktuell werden fuer `vector3d` zwei Versionen erzeugt:

- `viewer`: abgeleitetes Viewer-Modell
- `small`: Preview auf Basis von `viewer`

Unterstuetzte Upload-Formate sind `glb`, `gltf` und `obj`.

## Build

Das Plugin benoetigt die gebaute Viewer-App aus dem Nachbar-Plugin `../fylr-plugin-ubhd-3d-viewer`, weil deren `dist` fuer die Preview-Erzeugung in dieses Plugin gespiegelt wird.

```bash
make -C ../fylr-plugin-ubhd-3d-viewer build
make build
```

`make build` installiert die Node-Abhaengigkeiten, synchronisiert die benoetigten Viewer-Assets nach `src/server/recipe/viewer-dist/` und erzeugt das Plugin unter `build/ubhd-3d-recipes/`.

Fuer ein installierbares Paket:

```bash
make zip
```

Das ZIP liegt danach unter `build/ubhd-3d-recipes.zip`.
