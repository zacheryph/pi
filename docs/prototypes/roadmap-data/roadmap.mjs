#!/usr/bin/env node

import fs from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

// Fixed prototype schema evaluator; production should use the repository AJV setup.

const schema = JSON.parse(fs.readFileSync(new URL("./roadmap.schema.json", import.meta.url), "utf8"));

function shape(v,s,p='$') {
  const fail=m=>{throw new Error(p+': '+m)};
  if(s.anyOf){if(!s.anyOf.some(x=>{try{shape(v,x,p);return true}catch{return false}}))fail('does not match allowed shapes');return;}
  if('const' in s&&v!==s.const)fail('invalid constant');
  if(s.enum&&!s.enum.includes(v))fail('invalid choice');
  const types={object:v!==null&&typeof v==='object'&&!Array.isArray(v),array:Array.isArray(v),string:typeof v==='string',integer:Number.isInteger(v),boolean:typeof v==='boolean',null:v===null};
  if(s.type&&!types[s.type])fail('expected '+s.type);
  if(s.pattern&&!new RegExp(s.pattern).test(v))fail('invalid identifier');
  if(s.minimum!==undefined&&v<s.minimum)fail('below minimum');
  if(s.type==='object'){for(const k of s.required||[])if(!(k in v))fail('missing '+k);for(const[k,x]of Object.entries(v)){if(s.additionalProperties===false&&!(k in s.properties))fail('unknown field '+k);if(s.properties[k])shape(x,s.properties[k],p+'.'+k);}}
  if(s.type==='array'){if(s.minItems&&v.length<s.minItems)fail('too few items');if(s.uniqueItems&&new Set(v.map(x=>JSON.stringify(x))).size!==v.length)fail('duplicate items');v.forEach((x,i)=>shape(x,s.items,p+'['+i+']'));}
}

export function validate(r) {
  shape(r,schema);
  const fail=m=>{throw new Error(m)};
  const byId=new Map();
  for(const s of r.steps){
    if(byId.has(s.id))fail('Duplicate step ID: '+s.id);
    if(!s.title||!s.type||!s.track||!s.does||!s.rollback||!s.size)fail(s.id+': missing step detail');
    byId.set(s.id,s);
  }
  for(const s of r.steps){
    for(const id of [...s.dependsOn,...s.eases])if(!byId.has(id)||id===s.id)fail(s.id+': unknown or self reference '+id);
    if(s.execution.stage!=='pending'&&s.dependsOn.some(id=>byId.get(id).execution.stage!=='done'))fail(s.id+': started before dependencies finished');
    if(s.execution.stage==='done'){
      const e=s.execution.evidence;
      if(!e.some(x=>x.kind==='verification'&&x.result==='passed'&&x.ref))fail(s.id+': completion requires passing verification');
      if(s.execution.delivery==='local'&&!e.some(x=>x.kind==='commit'&&x.ref))fail(s.id+': completion requires commit evidence');
      if(s.execution.delivery==='pull_request'&&(!e.some(x=>x.kind==='merge'&&x.ref)||!e.some(x=>x.kind==='deploy'&&x.ref&&['passed','not_available'].includes(x.result))))fail(s.id+': completion requires merge and deploy disposition');
    }
  }
  const visiting=new Set(),visited=new Set();
  function visit(id){if(visiting.has(id))fail('Dependency cycle at '+id);if(visited.has(id))return;visiting.add(id);byId.get(id).dependsOn.forEach(visit);visiting.delete(id);visited.add(id);}
  r.steps.forEach(s=>visit(s.id));
  for(const q of r.questions)for(const id of q.blocks)if(!byId.has(id))fail('Question references unknown step '+id);
  if(r.status!=='draft'&&(!r.decision||!r.options.some(o=>o.id===r.decision.optionId)))fail('Chosen roadmap requires a valid decision');
  if(r.status==='done'&&r.steps.some(s=>s.execution.stage!=='done'))fail('Roadmap done before all steps finish');
  return r;
}

export function readiness(r,s) {
  if(s.execution.stage!=='pending')return s.execution.stage;
  const byId=new Map(r.steps.map(s=>[s.id,s]));
  if(r.status==='draft'||r.questions.some(q=>q.status==='open'&&q.blocks.includes(s.id)))return 'on hold';
  return s.dependsOn.every(id=>byId.get(id).execution.stage==='done')?'ready':'waiting';
}

function md(v){return String(v??'—').replaceAll('|','\\|').replaceAll('\n','<br>');}

function list(a){return a.length?a.map(x=>'- '+x).join('\n'):'None.';}

function table(keys,rows){return '| '+keys.join(' | ')+' |\n| '+keys.map(()=>'---').join(' | ')+' |\n'+rows.map(row=>'| '+row.map(md).join(' | ')+' |').join('\n');}

export function markdown(r) {
  r={...r,steps:[...r.steps].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id))};
  const g=r.goal;
  const lines=[`<!-- Generated roadmap ${r.id} · revision ${r.revision}. Edit source JSON and regenerate. -->`,
    '# '+r.title,`Status: ${r.status} · Updated: ${r.updated} · Revision: ${r.revision}`,'> '+r.disclaimer,
    '## Goal brief',`**Stated request:** ${g.request}`,`**True goal:** ${g.outcome}`,
    ...['consumers','successCriteria','nonGoals','constraints','openToChange','offLimits'].map(k=>`**${k}:**\n${list(g[k])}`),
    '**Appetite:** '+g.appetite,'## Answers',table(['ID','Question','Recommended','Answer','Source','Status'],r.answers.map(a=>[a.id,a.question,a.recommended,a.answer,a.source,a.status])),
    '## Inputs',table(['Input','Source','Owner','Supply','Tradeoff'],r.inputs.map(i=>[i.name,i.source,i.owner,i.supply,i.tradeoff])),
    '## What exists','**Prior art:**\n'+list(r.survey.priorArt),'**Conventions:**\n'+list(r.survey.conventions),
    table(['Friction','Evidence','Blocks','Verdict'],r.survey.friction.map(f=>[f.problem,f.evidence,f.blocks.join(', '),f.verdict])),
    '**Noticed, not doing:**\n'+list(r.survey.noticedNotDoing),'**Not examined:**\n'+list(r.survey.notExamined),'## Options',
    ...r.options.map(o=>`### ${o.id}: ${o.title}\n\n${o.idea}\n\n**Cost:** ${o.cost}\n\n**Risk:** ${o.risk}\n\n**Value timing:** ${o.valueTiming}\n\n**Makes easy:** ${o.makesEasy}\n\n**Leaves behind:** ${o.leavesBehind}\n\n**Choose when:** ${o.chooseWhen}`),
    '## Decision',r.decision?`${r.decision.optionId} · ${r.decision.by} · ${r.decision.at}\n\n${r.decision.reason}`:'No decision recorded.',
    '## Current implementation',`${r.steps.filter(s=>s.execution.stage==='done').length}/${r.steps.length} steps completed. This is a step count, not an effort estimate.`,
    table(['Step','Stage','Depends on'],r.steps.map(s=>[s.id,readiness(r,s),s.dependsOn.join(', ')||'—'])),
    '## Dependency map','Arrows mean prerequisite → dependent. Grouping and display order do not add dependencies.',
    '```mermaid\nflowchart TD\n'+r.steps.map((s,i)=>`  n${i}["${s.id}: ${s.title.replaceAll('"',"'")} · ${readiness(r,s)}"]`).join('\n')+'\n'+r.steps.flatMap((s,i)=>s.dependsOn.map(id=>`  n${r.steps.findIndex(x=>x.id===id)} --> n${i}`)).join('\n')+'\n```',
    '## Roadmap',...r.steps.map(s=>`### ${s.id}. ${s.title}\n\n**Type:** ${s.type} · **Track:** ${s.track} · **Size:** ${s.size}\n\n**Eases:** ${s.eases.join(', ')||'—'}\n\n**Does:** ${s.does}\n\n**Done when:**\n${list(s.doneWhen)}\n\n**Verification:**\n${list(s.verification)}\n\n**Ships alone:** ${s.shipsAlone?'yes':'no'}\n\n**Rollback:** ${s.rollback}\n\n**Depends on:** ${s.dependsOn.join(', ')||'none'}\n\n**Scope:** ${s.scope.join(', ')}\n\n**Stage:** ${readiness(r,s)}\n\n**Note:** ${s.execution.note||'—'}\n\n**Evidence:**\n${list(s.execution.evidence.map(e=>`${e.kind}: ${e.ref} (${e.result})`))}`),
    '## Open questions',...r.questions.filter(q=>q.status==='open').map(q=>`- ${q.id}: ${q.question} Blocks: ${q.blocks.join(', ')||'none'}. ${q.note}`)
  ];
  return lines.join('\n\n')+'\n';
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = "render", input = "example.roadmap.json", out = "generated"] = process.argv.slice(2);
    if (!["validate", "render"].includes(command)) {
      throw new Error("Usage: node roadmap.mjs validate|render input.json [output-directory]");
    }
    const r = validate(JSON.parse(fs.readFileSync(input, "utf8")));
    r.steps.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    if (command === "validate") {
      console.log("Valid roadmap: " + r.id);
    } else {
      const content = markdown(r);
      const template = fs.readFileSync(new URL("./template.html", import.meta.url), "utf8");
      const safe = (x) => JSON.stringify(x).replaceAll("<", "\\u003c");
      const html = template.replace("__ROADMAP_DATA__", safe(r)).replace("__MARKDOWN_DATA__", safe(content));
      fs.mkdirSync(out, { recursive: true });
      for (const [suffix, body] of [["md", content], ["html", html]]) {
        const target = path.join(out, r.id + "." + suffix);
        const temp = target + ".tmp";
        fs.writeFileSync(temp, body);
        fs.renameSync(temp, target);
      }
      console.log("Rendered Markdown and HTML at revision " + r.revision);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
