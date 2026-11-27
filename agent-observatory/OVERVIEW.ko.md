Agent Observatory는 Host의 모든 Paseo Agent와 Subagent를 한눈에 살펴볼 수 있는 대시보드입니다. 각 세션은 최신 결과, 타임라인, 하위 작업, 진단, 실행 리캡 순으로 열립니다. 사이드바에 확인 필요한 항목 수와 한 줄 이유를 표시하며, 인라인 승인 및 빠른 답장, 읽지 않음 대기열, 사용량 통계, 로컬 Token 집계(Claude Code, Codex, Grok CLI, Pi, Kimi Code, ZCode 등), 모든 예약 실행 내역, 선택적 AI 분석과 턴 요약을 제공합니다. 또한 알림음, 확인 필요 항목용 Workspace 라벨, Prompt Cache 카운트다운, 예약 전송 알림 기능도 선택적으로 켤 수 있습니다.

제공 화면: Agent Observatory, 보관된 세션, 예약 실행 페이지와 Workspace/Agent 패널, Command Center 항목, `/observe` 슬래시 명령. 클라이언트는 연결 시 작은 스텁만 먼저 불러오고, 나머지 UI는 처음 열 때 로드합니다.

## 준비 사항

Paseo 0.11.1 이상이 필요합니다. AI 분석과 턴 요약 기능을 사용하려면 Daemon Host에 로그인된 Grok CLI 또는 활성화된 Paseo Provider가 필요합니다.

## 언어

영어, 중국어(간체), 한국어가 기본 내장되어 있습니다. **설정 → 플러그인 → Agent Observatory → 언어**에서 별도로 지정하지 않으면 기기 언어를 따르며, 누락된 항목은 영어로 표시됩니다. `~/.paseo/plugin-data/agent-observatory/locales/`에 번역한 템플릿 복사본을 넣으면 사용자 정의 언어도 추가할 수 있습니다. AI 분석과 턴 요약도 선택한 언어로 작성됩니다.

## 읽는 데이터

- Daemon에서 읽는 정보: Agent 이벤트, 알림 상태, Agent 목록(보관됨 포함), 열어 본 Agent의 대기 중 권한 요청, Profile 및 Provider, Quota 창(`providers.listUsage()`, 화면에 표시할 때만 조회), 열어 본 세션의 타임라인. 백그라운드에서는 이미 로드된 Agent만 읽습니다.
- Token 로그: `$CLAUDE_CONFIG_DIR/projects`(기본 `~/.claude/projects`), `~/.config/claude/projects`, `$CODEX_HOME/sessions` 및 `archived_sessions`(기본 `~/.codex`), 각 Grok CLI 세션의 `usage.json`만 단독 조회, Pi 세션(기본 `~/.pi/agent/sessions`), `$KIMI_CODE_HOME/sessions`(기본 `~/.kimi-code/sessions`)의 Kimi Code wire 로그, `$ZCODE_HOME/cli/db`(기본 `~/.zcode/cli/db`)의 읽기 전용 ZCode SQLite DB 및 WAL(심볼릭 링크는 따라가지 않음). ZCode ACP ID는 `v2/acp-lazy-sessions.json`을 통해 매핑합니다. 카운터, 모델명, 작업 디렉터리, 세션 ID만 보관하며 Prompt나 출력 원문은 저장하지 않습니다.
- 위 Provider를 확장한 커스텀 Provider: Provider의 `env`, 명령줄 또는 런처 스크립트(텍스트로 최대 64 KB만 읽으며 실행하지 않음)에 명시된 `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME`, `ZCODE_HOME`, `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` 및 Pi의 `sessionDir` 설정.
- 재개 확인을 위해 해당 Agent의 Claude Code, Codex 또는 Pi 로그에서 실행 ID 일치 여부만 대조(저장하지 않음)하며, Prompt Cache 카운트다운은 Claude 기반 세션 로그에서 마지막 Cache 쓰기 시각과 TTL을 읽습니다.
- 예약 실행: `$PASEO_HOME/schedules/*.json`, `projects/workspaces.json`, Daemon이 더 이상 나열하지 않는 Agent 기록. 이 파일들은 절대 수정하지 않습니다.
- Daemon 설정의 Provider 목록(턴 도중 메시지 전달 가능 여부 및 Quota 공유 여부 판별).

플러그인 자체는 별도의 네트워크 요청을 보내지 않습니다.

## 쓰는 데이터

모든 데이터는 `$PASEO_HOME/plugin-data/agent-observatory`(디렉터리 0700, 파일 0600, 크기 제한 및 원자적 교체)에 저장됩니다: 텔레메트리, 통계, Token 집계, Quota 이력, 읽음 확인, 환경설정, 분석 설정, 리포트 및 제안, 턴 요약, 스케줄 및 재개 장부, 기기 시간대, 전송 장부(전송 대기·예약 메시지 및 일주일 치 짧은 미리보기), 플러그인 전용 Workspace 라벨 및 고정 상태, 언어 상태, 번역 템플릿.

스케줄 장부는 실행 시각, 상태, ID, Host 오류(최대 300자), 자격 증명이 제거된 링크, 스케줄 이름과 주기만 보관하며 답장이나 Prompt 원문은 저장하지 않습니다. Quota 이력의 계정명은 해시 처리합니다. 텔레메트리는 턴이 중단된 이유만 기록하고 답장 본문은 저장하지 않습니다. AI 리포트와 턴 요약은 세션 내용을 일부 인용할 수 있습니다.

## 수행하는 동작

플러그인은 사용자가 직접 요청할 때만 Daemon에 동작을 실행합니다:

- 결과·질문·오류를 읽음으로 표시, Agent 보관(일괄 보관은 2단계 확인 필요), Workspace 또는 보관된 세션 복원
- 권한 요청을 Provider가 제공한 옵션 그대로 건별 응답(일괄 승인이나 자동 승인은 하지 않음)
- 빠른 답장, AI 제안 또는 분석 발견 항목을 Agent로 전송: 지원되는 Provider는 실행 중인 턴에 바로 전달하고, 그렇지 않으면 중단 확인 후 전송하거나 턴 종료 후 전송하도록 대기열에 등록(재시도 시 최대 1회만 전달)
- 사용자가 확인한 시각에 일회성 Heartbeat를 예약해 Quota 초기화 후 Agent 재개(전달이 입증되지 않으면 재전송하지 않으며, 플러그인이 만든 재개 Heartbeat만 삭제)
- 멈춘 Agent를 다른 Profile로 인계하거나 제안 항목에서 새 Agent 시작
- 지정한 시각에 예약 메시지 전송
- 사이드바 라벨 기능을 켠 경우(기본 꺼짐), 플러그인 전용 Workspace 라벨과 고정 상태를 추가·제거

일부 기능은 플러그인 API에 없는 Daemon 메시지를 플러그인 자체 연결로 호출합니다. `http(s)` 링크를 외부 브라우저로 열 수 있습니다.

## AI 분석과 턴 요약

사용자가 시작하기 전에는 분석을 실행하지 않으며, 자동 분석은 기본 꺼짐 상태입니다. 분석 시 세션 발췌본(Prompt, 답장, 도구 호출 및 출력, 최대 180개 항목 / 약 120,000자)과 프로젝트·Agent 메타데이터를 선택한 모델로 전달합니다. 일반적인 형식의 자격 증명은 마스킹하지만 모든 형태를 완벽히 가리지 못할 수 있습니다. 제안 생성 시에도 최근 리포트 요약을 같은 방식으로 전달합니다.

- Grok CLI: 모든 내장 도구를 제거하고 도구 호출 거부, 웹 검색·메모리·세션 검색 비활성화 및 다른 Provider 키가 없는 새 임시 디렉터리에서 `grok`을 실행합니다. 발췌본은 임시 파일로 전달되며, 완료 후 임시 디렉터리와 저장된 세션·검색 기록을 삭제합니다. 플러그인이 실행하는 유일한 하위 프로세스입니다.
- Paseo Profile 또는 Provider: 분석 대상 Agent의 Workspace 안에 임시 Subagent를 만들어 읽기 전용 모드 또는 Claude Code의 Always Ask 모드로 실행합니다. 승인 요청은 거부하지만 승인이 필요 없는 작업(파일 읽기 등)은 마스킹 없이 실행될 수 있습니다. 완료 후 보관되며 대화 내역은 Host와 해당 Provider 로그에 남고 Quota를 소비합니다.
- 자동 선택(기본값): Grok CLI가 있으면 우선 사용하고, 없으면 활성화된 Claude Code 또는 Codex Provider를 사용합니다.

턴 요약도 기본 꺼짐 상태입니다. 켜두면 최상위 Agent의 턴이 끝난 지 10초 뒤 실행기(기본: Grok CLI, low effort)가 해당 턴과 이전 최대 8개 턴의 메시지(도구 출력 제외, 마스킹 적용, 최대 32 KB)를 읽어 한 줄 목표·진행 상황·다음 단계와 선택적 추천 답장을 작성합니다. 기능을 끄면 저장된 요약이 삭제됩니다.

## 제한 사항

- 가져오기 및 스캔에는 상한이 적용됩니다(예: Token 로그 최대 20,000개).

예약 실행 페이지는 panrafal의 schedule-runs 플러그인을 참고해 설계되었습니다.
