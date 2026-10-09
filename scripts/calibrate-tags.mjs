import {writeFileSync} from 'node:fs';
const rows=[];
for(const sort of ['heat','rank','score']){
 const r=await fetch('https://api.bgm.tv/v0/search/subjects?limit=100&offset=0',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:'',sort,filter:{type:[2],nsfw:false}})});
 if(!r.ok)throw Error(String(r.status)); rows.push(...(await r.json()).data);
}
const unique=[...new Map(rows.map(s=>[s.id,s])).values()];
writeFileSync('bangumi-backlog/qa/tag-calibration-sample.json',JSON.stringify(unique.map(s=>({id:s.id,name:s.name_cn||s.name,tags:s.tags})),null,2));
const counts=new Map();for(const s of unique)for(const t of s.tags||[])counts.set(t.name,(counts.get(t.name)||0)+1);
console.log(JSON.stringify({sampleSize:unique.length,commonTags:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,100),examples:unique.slice(0,15).map(s=>({id:s.id,name:s.name_cn||s.name,tags:s.tags.slice(0,10).map(t=>[t.name,t.count])}))}));
