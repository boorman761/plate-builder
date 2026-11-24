"""Builds core/profiles.json from slicer profile repositories.

Usage: python core/build_profiles.py ORCA_DIR ORCA_FLASHFORGE_DIR BAMBUSTUDIO_DIR
  ORCA_DIR             clone of https://github.com/SoftFever/OrcaSlicer (Creator 5 / 5 Pro profiles)
  ORCA_FLASHFORGE_DIR  clone of https://github.com/FlashForge/Orca-Flashforge (AD5X / 5M / 5M Pro profiles)
  BAMBUSTUDIO_DIR      clone of https://github.com/bambulab/BambuStudio (Bambu base settings)
"""
import os, sys
ORCA, OFF, BS = (sys.argv[1:4] + [None] * 3)[:3]
if not all([ORCA, OFF, BS]): sys.exit(__doc__)
import json,glob,os
def load(roots):
    idx={}
    for root in roots:
        for f in glob.glob(root+'/**/*.json',recursive=True):
            try: d=json.load(open(f),strict=False)
            except Exception: continue
            if isinstance(d,dict) and 'name' in d: idx[d['name']]=d
    cache={}
    def resolve(n):
        if n in cache: return cache[n]
        d=idx.get(n,{}); b=dict(resolve(d['inherits'])) if d.get('inherits') else {}
        for inc in d.get('include',[]):
            if inc not in idx: continue
            b.update({k:v for k,v in resolve(inc).items() if k not in('name','type','instantiation','inherits','include')})
        b.update(d); b.pop('include',None); cache[n]=b; return b
    return idx,resolve
FF=load([ORCA+'/resources/profiles/OrcaFilamentLibrary',ORCA+'/resources/profiles/Flashforge'])
FFO=load([ORCA+'/resources/profiles/OrcaFilamentLibrary',OFF+'/resources/profiles/Flashforge'])
BBL=load([BS+'/resources/profiles/BBL'])
VENDORS=[('ff',FFO,['Flashforge AD5X','Flashforge Adventurer 5M','Flashforge Adventurer 5M Pro'],('Flashforge','Generic'),'OrcaSlicer-2.3.0','01.10.01.50'),
         ('ff',FF,['Flashforge Creator 5','Flashforge Creator 5 Pro'],('Flashforge','Generic'),'BambuStudio-02.06.00.51','02.06.00.51'),]
import re
SKIP=re.compile(r'\b(PA|PA6|PA-CF|PA6-CF|PA6-GF|PAHT-CF|PPA-CF|PPA-GF|PC|PC FR|PE|PE-CF|PP|PP-CF|PP-GF|PET-CF|HIPS|EVA|PHA|BVOH|Support W|Support G|Support For PA/PET|ASA-CF|ASA-Aero|ABS-GF|PLA Aero|PLA Dynamic|PLA Palette|TPU 90A)\b')
META={'name','inherits','from','setting_id','instantiation','type','compatible_printers','compatible_printers_condition','compatible_prints','compatible_prints_condition','renamed_from','description','version','is_custom_defined','filament_id','base_id','include'}
out={'printers':[]}; store={'machine':{},'process':{},'filament':{}}
for vendor,(idx,resolve),models,prefixes,app,ver in VENDORS:
  res={n:resolve(n) for n,d in idx.items() if d.get('instantiation')=='true'}
  for model in models:
    machines=sorted([n for n,r in res.items() if r.get('type')=='machine' and r.get('printer_model')==model], key=lambda n: float(res[n]['nozzle_diameter'][0]))
    for mn in machines:
      m=res[mn]
      procs=sorted([n for n,r in res.items() if r.get('type')=='process' and mn in r.get('compatible_printers',[])], key=lambda n:(float(res[n]['layer_height']),n))
      fils=sorted([n for n,r in res.items() if r.get('type')=='filament' and mn in r.get('compatible_printers',[]) and n.startswith(prefixes) and not (vendor=='bbl' and SKIP.search(n))])
      for n,t in [(mn,'machine')]+[(p,'process') for p in procs]+[(f,'filament') for f in fils]:
        if n in store[t] and t!='machine': continue
        assert n not in store[t], n
        store[t][n]={k:v for k,v in res[n].items() if k not in META}
        if t=='filament': store[t][n]['filament_ids']=[res[n].get('filament_id','')]
      label=model.replace('Flashforge ','').replace('Bambu Lab ','Bambu ')
      out['printers'].append({'vendor':vendor,'app':app,'orcaTag':('2.4.2' if app.startswith('BambuStudio-02.06') else ''),'cfgVersion':ver,'model':label,'machine':mn,'nozzle':m['nozzle_diameter'][0],'extruders':len(m['nozzle_diameter']),'semm':m.get('single_extruder_multi_material')=='1','area':m['printable_area'],'height':m['printable_height'],'exclude':m.get('bed_exclude_area',[]),'processes':procs,'filaments':fils})
for t,d in store.items():
  keys=set.intersection(*[set(v) for v in d.values()]); first=d[next(iter(d))]
  base={k:first[k] for k in keys if all(json.dumps(v[k])==json.dumps(first[k]) for v in d.values())}
  out[t+'_base']=base
  out[t]={n:{k:v for k,v in p.items() if k not in base or json.dumps(base[k])!=json.dumps(v)} for n,p in d.items()}
s=json.dumps(out,separators=(',',':'))
open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'profiles.json'),'w').write(s)
print(len(s), {t:len(d) for t,d in store.items()})
