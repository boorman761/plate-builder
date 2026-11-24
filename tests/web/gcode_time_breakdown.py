import re,sys,collections
g=open(sys.argv[1]).read().split('\n')
x=y=z=0;f=3000;cur='start';T=collections.Counter();D=collections.Counter();Fs=collections.defaultdict(collections.Counter)
for l in g:
    if l.startswith(';TYPE:'): cur=l[6:]; continue
    if l.startswith('; FEATURE:'): cur='F:'+l[10:].strip(); continue
    if 'CP TOOLCHANGE WIPE' in l: cur='tower wipe'; continue
    if l.startswith(('G0 ','G1 ')):
        nx,ny,nz,e=x,y,z,0; travel=True
        for w in l.split(';')[0].split()[1:]:
            v=float(w[1:]) if len(w)>1 else 0
            if w[0]=='X':nx=v
            elif w[0]=='Y':ny=v
            elif w[0]=='Z':nz=v
            elif w[0]=='F':f=v or f
            elif w[0]=='E':e=v
        d=((nx-x)**2+(ny-y)**2+(nz-z)**2)**.5 or abs(e)
        k=cur if e>0 and d>abs(e) else 'travel/retract'
        T[k]+=d/max(1,f/60); D[k]+=d; Fs[k][round(f/60)]+=d
        x,y,z=nx,ny,nz
tot=sum(T.values())
for k,v in T.most_common(): print(f'{k:28s} {v/60:7.1f} min  {D[k]/1000:6.1f} m  speeds {Fs[k].most_common(3)}')
print('total min', tot/60)
