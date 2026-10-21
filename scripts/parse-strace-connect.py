import re,sys,collections
f=sys.argv[1]; gw=sys.argv[2]
net=collections.OrderedDict(); unix=collections.Counter(); kids=collections.Counter()
for l in open(f):
    m=re.match(r'(\d+) (\d+:\d+:\d+\.\d+) connect\(\d+, \{sa_family=(AF_\w+),(.*)\}, \d+\) = (.*)',l)
    if not m: continue
    pid,t,fam,rest,res=m.groups()
    if fam=='AF_UNIX':
        p=re.search(r'sun_path="([^"]*)"',rest); 
        if pid==gw: unix[re.sub(r'[0-9a-f]{12}-[0-9a-f]{40,}','<mux>',re.sub(r'oc-spawn-\w+','oc-spawn-X',p.group(1)) if p else '?')]+=1
        continue
    if fam=='AF_INET': ip=re.search(r'inet_addr\("([^"]+)"',rest).group(1); port=re.search(r'htons\((\d+)\)',rest).group(1)
    elif fam=='AF_INET6': ip=re.search(r'"([0-9a-f:]+)"',rest).group(1); port=re.search(r'htons\((\d+)\)',rest).group(1)
    else: continue
    key=(ip,port)
    if pid==gw: net.setdefault(key,[]).append(t)
    else: kids[key]+=1
print("GATEWAY PID",gw)
for (ip,port),ts in net.items(): print(f"  {ip}:{port}  x{len(ts)}  first {ts[0]} last {ts[-1]}")
print("GATEWAY unix sockets:"); [print("  ",c,p) for p,c in unix.most_common()]
print("CHILD processes (sbx CLI etc.), port 443 only (port-53 connects are resolver lookups):"); [print("  ",f"{ip}:{port}",c) for (ip,port),c in kids.most_common() if port=="443"]
