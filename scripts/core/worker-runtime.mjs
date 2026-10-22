// Sampling an old record is not a new host state assertion.
export function cachedRuntimeClaim(row,{route,turn,now=Date.now(),ttlSeconds=60}={}){
 const source=row?.source_event_at||row?.status_at||row?.last_seen_at;
 const at=Date.parse(source),state={running:'active',waiting:'waiting',idle:'idle',ended:'ended',interrupted:'ended'}[row?.status];
 const fresh=!!route&&!!turn&&row?.session_id===route&&row?.current_turn_id===turn&&!!state&&Number.isFinite(at)&&at<=now&&now-at<Math.min(60,Math.max(1,ttlSeconds))*1000;
 return {sampled_at:new Date(now).toISOString(),runtime:fresh?state:'unknown',running:fresh&&state==='active',source_event_at:source??null,assurance:'cached-observation',fresh:!!fresh};
}
