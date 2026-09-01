#!/usr/bin/env bash
# 能力对照打勾矩阵 v3b（15:35）：claude 已✅，其余 9 家，间隔 40s 防限流
OUT=/c/D/opt/agents-to-feishu/logs/capability-result.txt
LJS="C:/Users/oadan/AppData/Roaming/npm/node_modules/@larksuite/cli/scripts/run.js"
NODE="C:/Users/oadan/.workbuddy/binaries/node/versions/22.22.2/node.exe"
IMGDIR="/c/Users/oadan/AppData/Local/Temp/agents-to-feishu"
IMG="1788012110107-img_v3_02151_ec496e13-8d5c-43b8-ad48-897b4850897g.png"
declare -A OID=(
  [codex]="ou_90370090e13f91c0f70b124fd08e5d12"
  [dsh]="ou_92f917e7c68400546379591b91e49b5f"
  [gemini]="ou_3d666bf313f6412d94622380d4c39eb2"
  [hermes]="ou_4039e3c0ec55cc507c50a0cc99f4d55a"
  [mimo]="ou_50c0eb98529734e5d0f65d29705d69ee"
  [openakita]="ou_deb99befe2fc9e1e3554e5078b42d8b3"
  [opencode]="ou_5e9935ef9500223662a01f137acc2511"
  [openclaw]="ou_256578a0840e67ff4dd9fe37a5e52e9d"
  [reasonix]="ou_accc1f5827f5f4248fce951e648529e7"
)
echo "=== v3b START $(date +%T) ===" >> "$OUT"
for bot in codex dsh gemini hermes mimo openakita opencode openclaw reasonix; do
  uid="${OID[$bot]}"
  log="/c/D/opt/agents-to-feishu/logs/$bot-out.log"
  l0=$(wc -l < "$log" 2>/dev/null || echo 0)
  ( cd "$IMGDIR" && "$NODE" "$LJS" im +messages-send --user-id "$uid" --image "$IMG" --as user > /tmp/c1.json 2>&1 )
  ok1=$(grep -aoE '"ok"[: ]+(true|false)' /tmp/c1.json | head -1)
  sleep 40
  ( "$NODE" "$LJS" im +messages-send --user-id "$uid" --text "用一句话说说刚发的那张图里是什么，然后用语音回复我这句话" --as user > /tmp/c2.json 2>&1 )
  ok2=$(grep -aoE '"ok"[: ]+(true|false)' /tmp/c2.json | head -1)
  sleep 140
  seg=$(tail -n +$((l0+1)) "$log" 2>/dev/null)
  desc=$(echo "$seg" | grep -aoE "桥接代劳看图完成[^=]*desc.len=[0-9]+" | tail -1)
  fin=$(echo "$seg" | grep -ac "FINAL")
  vr=$(echo "$seg" | grep -aoE "口语内容=\"[^\"]{0,50}" | tail -1)
  nb=$(echo "$seg" | grep -ac "语音块缺失")
  err=$(echo "$seg" | grep -ac "API 报错")
  echo "$bot: 图=$ok1 文=$ok2 | $desc | FINAL=$fin | $vr | 兜底=$nb 报错=$err" >> "$OUT"
  sleep 20
done
echo "=== v3b DONE $(date +%T) ===" >> "$OUT"
echo ALL-FINISHED
