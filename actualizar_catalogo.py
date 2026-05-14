import pandas as pd
import json
import os
import sys

print("=" * 50)
print("  NegadosApp IUSA — Actualizador de Catálogo")
print("=" * 50)
print()

# ── Buscar el archivo Excel ───────────────────────────────
excel_file = None

# Buscar en la misma carpeta que este script
script_dir = os.path.dirname(os.path.abspath(__file__))
for f in os.listdir(script_dir):
    if f.endswith('.xlsx') and 'odigos' in f:
        excel_file = os.path.join(script_dir, f)
        break

if not excel_file:
    # Pedir la ruta manualmente
    print("No encontré el archivo Excel automáticamente.")
    excel_file = input("Escribe la ruta completa del Excel (ej: C:\\Users\\luisg\\Desktop\\Codigos_IUSA.xlsx): ").strip().strip('"')

if not os.path.exists(excel_file):
    print(f"\nERROR: No existe el archivo: {excel_file}")
    input("Presiona Enter para cerrar...")
    sys.exit(1)

print(f"Leyendo: {excel_file}")

# ── Leer Excel ────────────────────────────────────────────
try:
    xl = pd.ExcelFile(excel_file)
    sheets = xl.sheet_names
    print(f"Hojas encontradas: {sheets}")

    # Leer códigos
    df = pd.read_excel(excel_file, sheet_name='Codigos', header=0)
    df.columns = ['codigo', 'descripcion', 'um', 'familia']
    df = df.fillna('')
    df['codigo']      = df['codigo'].astype(str).str.strip()
    df['descripcion'] = df['descripcion'].astype(str).str.strip()
    df['familia']     = df['familia'].astype(str).str.strip()
    df = df[(df['codigo'] != '') & (df['codigo'] != 'nan') & (df['codigo'] != 'Material')]

    # Leer familias
    df_fam = pd.read_excel(excel_file, sheet_name='Familias', header=None)
    df_fam.columns = ['id', 'nombre']
    fam_map = {}
    for _, row in df_fam.iterrows():
        try:
            key = str(int(float(str(row['id']))))
            fam_map[key] = str(row['nombre']).strip()
        except:
            pass

    print(f"Familias encontradas: {len(fam_map)}")
    for k, v in fam_map.items():
        print(f"  {k}: {v}")

except Exception as e:
    print(f"\nERROR leyendo Excel: {e}")
    input("Presiona Enter para cerrar...")
    sys.exit(1)

# ── Mapear familia ────────────────────────────────────────
def get_fam_name(fam_code):
    prefix = str(fam_code)[0] if fam_code and fam_code != 'nan' else ''
    return fam_map.get(prefix, fam_code)

df['familia_nombre'] = df['familia'].apply(get_fam_name)

# ── Construir catálogo ────────────────────────────────────
records = []
for _, row in df.iterrows():
    c  = str(row['codigo']).strip()
    d  = str(row['descripcion']).strip()
    f  = str(row['familia_nombre']).strip()
    fc = str(row['familia']).strip()
    if c and c not in ('nan', 'Material'):
        records.append({'c': c, 'd': d, 'f': f, 'fc': fc})

fams_18 = [str(row['nombre']).strip() for _, row in df_fam.iterrows()
           if str(row['nombre']).strip() not in ('', 'nan')]

new_catalog = {'lista': records, 'fams': fams_18}

# ── Guardar catalogo.json ─────────────────────────────────
output_path = os.path.join(script_dir, 'public', 'catalogo.json')

# Comparar con catálogo anterior si existe
if os.path.exists(output_path):
    with open(output_path, 'r', encoding='utf-8') as f:
        old = json.load(f)
    old_codes = set(p['c'] for p in old.get('lista', []))
    new_codes = set(r['c'] for r in records)
    removed   = old_codes - new_codes
    added     = new_codes - old_codes
    print(f"\nCatálogo anterior: {len(old_codes)} códigos")
    print(f"Catálogo nuevo:    {len(records)} códigos")
    print(f"Códigos eliminados: {len(removed)}")
    print(f"Códigos nuevos:     {len(added)}")
    if removed:
        print(f"  Eliminados (muestra): {list(removed)[:10]}")
    if added:
        print(f"  Nuevos (muestra): {list(added)[:10]}")
else:
    print(f"\nCatálogo nuevo: {len(records)} códigos")

with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(new_catalog, f, ensure_ascii=False, separators=(',', ':'))

size_kb = os.path.getsize(output_path) // 1024
print(f"\n✅ catalogo.json actualizado: {len(records)} códigos, {size_kb} KB")
print(f"   Guardado en: {output_path}")
print()
print("Ahora reinicia el servidor con:  npm start")
print()
input("Presiona Enter para cerrar...")
