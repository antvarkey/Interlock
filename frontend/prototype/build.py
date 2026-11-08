import json,re
t=open('template.html').read()
data=open('data.json').read()
t=t.replace('/*CSS*/',open('style.css').read()).replace('/*ENGINE*/',open('engine.js').read()).replace('/*APP*/',open('app.js').read())
t=t.replace('/*DATA*/',data.replace('</','<\\/'))
open('interlock.html','w').write(t)
print(len(t))
