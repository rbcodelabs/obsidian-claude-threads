/**
 * ClaudeThreadsShots — Static screenshot compositions for Reddit/social
 *
 * Matches the real "Claude Warm" Obsidian theme exactly.
 * Render individual frames as stills:
 *   Frame  0  → Main view (conversation + agent dashboard)
 *   Frame 60  → Slash command dropdown (skills list)
 *   Frame 120 → Streaming response with tool calls
 *
 * Usage:
 *   npx remotion still src/index.ts ClaudeThreadsShots out/shot-main.png --frame=0
 */

import { AbsoluteFill, useCurrentFrame } from 'remotion'

// ─── Claude Warm theme (exact values from theme.css) ────────────────────────
const CW_BG_PRIMARY    = '#2d2e2d'   // --background-primary
const CW_BG_SECONDARY  = '#2a2b2a'   // --background-secondary / titlebar / tab container
const CW_BG_SECONDARY2 = '#282928'   // --color-base-10 (slightly darker panels)
const CW_BG_HOVER      = 'rgba(229,229,226,0.06)'
const CW_BORDER        = 'rgba(203,199,187,0.14)'
const CW_BORDER_HOVER  = 'rgba(203,199,187,0.22)'
const CW_TEXT          = '#e9e6dc'   // hsl(50,14%,91%)
const CW_TEXT_MUTED    = '#bbb6a8'   // hsl(48,10%,72%)
const CW_TEXT_FAINT    = '#8c887e'   // hsl(48,7%,58%)
const CW_ACCENT        = '#ea928a'   // --interactive-accent (salmon)
const CW_ACCENT_HOVER  = '#f1a59e'   // --interactive-accent-hover
const CW_ON_ACCENT     = '#2a1e1b'   // --text-on-accent (dark brown)
const CW_SUCCESS       = '#9ab889'   // --interactive-success
const CW_FORM_FIELD    = '#3d3d3a'   // --background-modifier-form-field
const CW_TAB_ACTIVE    = '#2d2e2d'   // --tab-background-active (same as primary)

// Claude Threads panel uses GitHub Dark (hardcoded in plugin)
const CT_BG     = '#0d1117'
const CT_CARD   = '#161b22'
const CT_BORDER = '#21262d'
const CT_TEXT   = '#e6edf3'
const CT_MUTED  = '#8b949e'
const CT_BLUE   = '#58a6ff'
const CT_GREEN  = '#3fb950'
const CT_AMBER  = '#f0883e'

const SANS = "'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
const SERIF = "ui-serif, Georgia, Cambria, 'Times New Roman', serif"

// ─── Layout constants ────────────────────────────────────────────────────────
// SCALE = 1.25 zoom, MARGIN = 28px → content base = WIN / SCALE
// WIN_W = 1864, WIN_H = 1024 → content base = 1491 × 819
const W = 1491
const H = 819
// Chrome heights (scaled down proportionally from real UI)
const TITLEBAR_H  = 36   // macOS + Obsidian toolbar
const FILETAB_H   = 27   // Obsidian file tab bar (above editor)
const STATUSBAR_H = 18   // bottom status bar
const CONTENT_H = H - TITLEBAR_H - STATUSBAR_H
// Panel widths — sum exactly to W
const CT_W      = 340   // Claude Threads left panel
const EDITOR_W  = 745   // center editor
const DASH_W    = W - CT_W - EDITOR_W  // 406 Agent Dashboard

// ─── macOS + Obsidian title bar ──────────────────────────────────────────────
function TitleBar() {
  return (
    <div style={{
      height: TITLEBAR_H,
      background: CW_BG_SECONDARY,
      borderBottom: `1px solid ${CW_BORDER}`,
      display: 'flex', alignItems: 'center',
      flexShrink: 0, position: 'relative',
      paddingLeft: 14, paddingRight: 16,
    }}>
      {/* Traffic lights */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginRight: 16 }}>
        <div style={{ width: 13, height: 13, borderRadius: 7, background: '#ff5f57', flexShrink: 0 }} />
        <div style={{ width: 13, height: 13, borderRadius: 7, background: '#febc2e', flexShrink: 0 }} />
        <div style={{ width: 13, height: 13, borderRadius: 7, background: '#28c840', flexShrink: 0 }} />
      </div>

      {/* Left Obsidian toolbar icons */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginRight: 10 }}>
        {/* Command palette */}
        <ToolbarIcon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </ToolbarIcon>
        {/* Search */}
        <ToolbarIcon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </ToolbarIcon>
        {/* Files */}
        <ToolbarIcon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </ToolbarIcon>
        {/* Bookmark */}
        <ToolbarIcon>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </ToolbarIcon>
      </div>

      {/* Sidebar toggle */}
      <ToolbarIcon style={{ marginRight: 8 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>
        </svg>
      </ToolbarIcon>

      {/* Center — breadcrumb */}
      <div style={{
        position: 'absolute', left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: SANS, fontSize: 13, color: CW_TEXT_MUTED }}>Claude</span>
          <span style={{ fontFamily: SANS, fontSize: 13, color: CW_TEXT_FAINT }}>/</span>
          <span style={{ fontFamily: SANS, fontSize: 13, color: CW_TEXT }}>claude-threads-spec</span>
        </div>
      </div>

      {/* Right toolbar icons */}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
        {[
          // list-tree
          <svg key="list" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
          // link
          <svg key="link" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
          // tag
          <svg key="tag" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
          // layout-dashboard
          <svg key="dash" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>,
          // grid
          <svg key="grid" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
        ].map((icon, i) => <ToolbarIcon key={i}>{icon}</ToolbarIcon>)}
      </div>
    </div>
  )
}

function ToolbarIcon({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      width: 28, height: 28, borderRadius: 5,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: CW_TEXT_FAINT,
      ...style,
    }}>{children}</div>
  )
}

// ─── Status bar ──────────────────────────────────────────────────────────────
function StatusBar() {
  return (
    <div style={{
      height: STATUSBAR_H,
      background: CW_BG_SECONDARY,
      borderTop: `1px solid ${CW_BORDER}`,
      display: 'flex', alignItems: 'center',
      paddingLeft: 14, paddingRight: 14,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: SANS, fontSize: 11, color: CW_TEXT_FAINT }}>Personal</span>
        <StatusIcon>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </StatusIcon>
        <StatusIcon>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
        </StatusIcon>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        {[
          '2 backlinks',
          '847 words · 5,240 characters',
          'Keeping awake',
          '↑↓ GDocs',
          '1 bridge ✓',
        ].map((label, i) => (
          <span key={i} style={{ fontFamily: SANS, fontSize: 11, color: CW_TEXT_FAINT }}>{label}</span>
        ))}
      </div>
    </div>
  )
}

function StatusIcon({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: CW_TEXT_FAINT, display: 'flex', alignItems: 'center' }}>{children}</div>
  )
}

// ─── Claude Threads panel (left) ─────────────────────────────────────────────
const CT_TABS = [
  'claude-threads-spec',
  'this morning — HipTrip',
  "I'd love to develop",
  "I'd like to make an",
  'Dream skill brainstorm',
  'HipTrip onboarding',
]

function CTTabBar({ activeIdx = 0 }) {
  const shown = CT_TABS.slice(0, 5)
  return (
    <div style={{
      display: 'flex', flexDirection: 'row', alignItems: 'flex-end',
      background: CW_BG_SECONDARY,
      borderBottom: `1px solid ${CW_BORDER}`,
      height: 34, flexShrink: 0, overflow: 'hidden',
      paddingLeft: 4,
    }}>
      {shown.map((label, i) => {
        const active = i === activeIdx
        const truncated = label.length > 14 ? label.slice(0, 12) + '…' : label
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 5,
            height: '100%', paddingLeft: 10, paddingRight: 8,
            background: active ? CT_BG : 'transparent',
            borderRight: `1px solid ${CT_BORDER}`,
            borderBottom: active ? 'none' : undefined,
            flexShrink: 0,
          }}>
            <span style={{
              fontFamily: SANS, fontSize: 11.5,
              color: active ? CT_TEXT : CT_MUTED,
              fontWeight: active ? 500 : 400,
              whiteSpace: 'nowrap',
            }}>{truncated}</span>
            <span style={{ fontFamily: SANS, fontSize: 11, color: CT_MUTED, opacity: 0.5 }}>×</span>
          </div>
        )
      })}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: '100%', flexShrink: 0,
        color: CT_MUTED,
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{
        display: 'flex', alignItems: 'center',
        paddingRight: 8, paddingLeft: 6,
        fontFamily: MONO, fontSize: 10.5,
        color: CW_TEXT_FAINT,
      }}>$0.0546</div>
    </div>
  )
}

function CTMessage({ role, content, toolCalls }: {
  role: 'user' | 'assistant'
  content: React.ReactNode
  toolCalls?: { icon: string; text: string }[]
}) {
  if (role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <div style={{
          background: CW_ACCENT,
          color: CW_ON_ACCENT,
          borderRadius: '12px 12px 2px 12px',
          padding: '8px 12px',
          maxWidth: '85%',
          fontFamily: SANS, fontSize: 13, lineHeight: 1.5,
        }}>{content}</div>
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 10 }}>
      {toolCalls && toolCalls.length > 0 && (
        <div style={{ marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {toolCalls.map((tc, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '4px 9px', background: CT_CARD, borderRadius: 6,
              border: `1px solid ${CT_BORDER}`,
            }}>
              <span style={{ fontSize: 11 }}>{tc.icon}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: CT_MUTED }}>{tc.text}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{
        fontFamily: SANS, fontSize: 13, color: CT_TEXT, lineHeight: 1.6,
      }}>{content}</div>
    </div>
  )
}

function CTInputBar({ value = 'Ask Claude...' }: { value?: string }) {
  return (
    <div style={{
      borderTop: `1px solid ${CT_BORDER}`,
      background: CT_CARD,
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
      }}>
        <div style={{
          flex: 1,
          fontFamily: SANS, fontSize: 13,
          color: value === 'Ask Claude...' ? CT_MUTED : CT_TEXT,
        }}>{value}</div>
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: value === 'Ask Claude...' ? 'transparent' : CT_BLUE,
          border: `1px solid ${CT_BORDER}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: value === 'Ask Claude...' ? CT_MUTED : '#fff',
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </div>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingLeft: 12, paddingRight: 12, paddingBottom: 6,
      }}>
        <span style={{ fontFamily: SANS, fontSize: 11, color: CW_TEXT_FAINT }}>Personal</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontFamily: SANS, fontSize: 11, color: CW_TEXT_FAINT }}>?</span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={CW_TEXT_FAINT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
        </div>
      </div>
    </div>
  )
}

function SlashDropdown() {
  const skills = [
    { name: '/brain-dump',             desc: 'Capture knowledge to Obsidian' },
    { name: '/brainstorm',             desc: 'Active ideation with Claude leading' },
    { name: '/dream',                  desc: 'Mine conversations for patterns' },
    { name: '/pr-checklist',           desc: 'Pre-PR definition-of-done checklist' },
    { name: '/synthesize-interviews',  desc: 'Cluster signals into opportunities' },
    { name: '/update-ost',             desc: 'Rebuild opportunity solution tree' },
  ]
  return (
    <div style={{
      background: CT_CARD, border: `1px solid ${CT_BORDER}`,
      borderRadius: 8, overflow: 'hidden',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    }}>
      <div style={{
        padding: '6px 10px 5px', borderBottom: `1px solid ${CT_BORDER}`,
        fontFamily: MONO, fontSize: 11, color: CT_MUTED,
      }}>skills — type to filter</div>
      {skills.map((skill, i) => (
        <div key={i} style={{
          padding: '7px 10px',
          background: i === 0 ? 'rgba(88,166,255,0.1)' : 'transparent',
          borderBottom: i < skills.length - 1 ? `1px solid ${CT_BORDER}` : undefined,
          borderLeft: i === 0 ? `2px solid ${CT_BLUE}` : '2px solid transparent',
        }}>
          <div style={{ fontFamily: MONO, fontSize: 12.5, color: i === 0 ? CT_BLUE : CT_TEXT }}>{skill.name}</div>
          <div style={{ fontFamily: SANS, fontSize: 11, color: CT_MUTED, marginTop: 1 }}>{skill.desc}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Scene 1: Main conversation view ─────────────────────────────────────────
function CTPanel_Main() {
  return (
    <div style={{
      width: CT_W, background: CT_BG, height: '100%',
      display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${CT_BORDER}`,
    }}>
      <CTTabBar activeIdx={0} />
      {/* Thread info bar */}
      <div style={{
        padding: '5px 12px', background: CT_CARD,
        borderBottom: `1px solid ${CT_BORDER}`,
        fontFamily: SANS, fontSize: 11.5, color: CT_MUTED,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={CT_MUTED} strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
        <span>Reviewing claude-threads spec for completeness</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: MONO, fontSize: 10.5,
            background: 'rgba(88,166,255,0.12)', border: `1px solid rgba(88,166,255,0.2)`,
            borderRadius: 4, padding: '1px 6px', color: CT_BLUE,
          }}>sonnet</span>
        </div>
      </div>
      {/* Messages */}
      <div style={{ flex: 1, padding: '14px 12px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <CTMessage role="user" content="Can you review the claude-threads-spec and tell me if there are any gaps in the install section?" />
        <CTMessage
          role="assistant"
          toolCalls={[
            { icon: '📖', text: 'Read: Claude/claude-threads-spec.md' },
            { icon: '📖', text: 'Read: README.md' },
          ]}
          content={
            <span>
              The install section covers BRAT and manual install well. Two gaps worth adding:{' '}
              <strong style={{ color: CT_TEXT }}>1)</strong>{' '}
              a note that Claude Code must already be authenticated before launching the plugin —
              it won't prompt you and will silently fail.{' '}
              <strong style={{ color: CT_TEXT }}>2)</strong>{' '}
              AWS Bedrock users need <code style={{ fontFamily: MONO, fontSize: 12, background: 'rgba(255,255,255,0.07)', padding: '1px 4px', borderRadius: 3 }}>AWS_PROFILE</code> and{' '}
              <code style={{ fontFamily: MONO, fontSize: 12, background: 'rgba(255,255,255,0.07)', padding: '1px 4px', borderRadius: 3 }}>AWS_REGION</code>{' '}
              set in Extra Env Vars — worth calling that out explicitly.
            </span>
          }
        />
        <CTMessage role="user" content="Good catches. Can you update the spec with both of those?" />
        <CTMessage
          role="assistant"
          toolCalls={[
            { icon: '✏️', text: 'Edit: Claude/claude-threads-spec.md' },
          ]}
          content="Done — added a prerequisites callout before the BRAT steps and an AWS Bedrock note in the settings table. Want me to also update the README to match?"
        />
      </div>
      <CTInputBar />
    </div>
  )
}

// ─── Scene 2: Slash command dropdown ─────────────────────────────────────────
function CTPanel_Slash() {
  return (
    <div style={{
      width: CT_W, background: CT_BG, height: '100%',
      display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${CT_BORDER}`,
    }}>
      <CTTabBar activeIdx={1} />
      <div style={{
        padding: '5px 12px', background: CT_CARD,
        borderBottom: `1px solid ${CT_BORDER}`,
        fontFamily: SANS, fontSize: 11.5, color: CT_MUTED,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={CT_MUTED} strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
        <span>Planning HipTrip feature prioritization</span>
      </div>
      <div style={{ flex: 1, padding: '14px 12px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <CTMessage role="user" content="I have a bunch of interview notes from this week. Can you help me figure out what to build next?" />
        <CTMessage
          role="assistant"
          content="Sure — you can use the /synthesize-interviews skill for exactly this. It'll cluster the signals into ranked opportunities. Or if you want to go broader first, /brainstorm is good for blue-sky exploration. Type / to see all available skills."
        />
        <div style={{ flex: 1 }} />
        <SlashDropdown />
        {/* Input showing "/" typed */}
        <div style={{
          borderTop: `1px solid ${CT_BORDER}`, background: CT_CARD, marginTop: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
            <div style={{ flex: 1, fontFamily: MONO, fontSize: 13, color: CT_TEXT }}>/</div>
            <div style={{
              width: 28, height: 28, borderRadius: 6,
              border: `1px solid ${CT_BORDER}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: CT_MUTED,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 12, paddingBottom: 6 }}>
            <span style={{ fontFamily: SANS, fontSize: 11, color: CW_TEXT_FAINT }}>Personal</span>
            <span style={{ fontFamily: SANS, fontSize: 11, color: CW_TEXT_FAINT }}>?</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Scene 3: Streaming response with tool calls ──────────────────────────────
function CTPanel_Stream() {
  return (
    <div style={{
      width: CT_W, background: CT_BG, height: '100%',
      display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${CT_BORDER}`,
    }}>
      <CTTabBar activeIdx={2} />
      <div style={{
        padding: '5px 12px', background: CT_CARD,
        borderBottom: `1px solid ${CT_BORDER}`,
        fontFamily: SANS, fontSize: 11.5, color: CT_MUTED,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={CT_MUTED} strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
        <span>Marketing plan for Reddit launch</span>
      </div>
      <div style={{ flex: 1, padding: '14px 12px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <CTMessage role="user" content="/brainstorm Claude Threads Reddit marketing — r/ObsidianMD, what angle and post structure?" />
        {/* Active streaming response */}
        <div style={{ marginBottom: 0 }}>
          {/* Tool calls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
            {[
              { icon: '📖', text: 'Read: Claude/obsidian-plugin-video-storyboard.md', done: true },
              { icon: '📖', text: 'Read: Claude/linkedin-content-calendar.md', done: true },
              { icon: '🔧', text: 'Bash: cat README.md', done: true },
            ].map((tc, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '4px 9px', background: CT_CARD, borderRadius: 6,
                border: `1px solid ${CT_BORDER}`,
              }}>
                <span style={{ fontSize: 11 }}>{tc.icon}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: CT_MUTED, flex: 1 }}>{tc.text}</span>
                {tc.done && <span style={{ fontSize: 10, color: CT_GREEN }}>✓</span>}
              </div>
            ))}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 13, color: CT_TEXT, lineHeight: 1.65 }}>
            <strong style={{ color: CT_TEXT }}>r/ObsidianMD is the right call.</strong>{' '}
            250k+ members who are already Obsidian-native — they don't need convincing on the vault.
            The differentiating hook is the subprocess approach: you're not adding another AI
            integration, you're bringing in the one you <em>already configured</em>.{'\n\n'}
            <span style={{ color: CT_TEXT }}>
              Best angle: "I got tired of switching between my vault and terminal, so I built this."
              Concrete friction story first, features second. The slash command dropdown screenshot
              is your strongest visual — it shows{' '}
            </span>
            <span style={{ color: CW_ACCENT }}>your actual skills</span>
            <span style={{ color: CT_TEXT }}>
              {' '}appearing in the autocomplete
            </span>
            <span style={{
              display: 'inline-block', width: 2, height: '1em',
              background: CT_BLUE, marginLeft: 2, verticalAlign: 'text-bottom',
            }} />
          </div>
        </div>
      </div>
      <CTInputBar />
    </div>
  )
}

// ─── Editor panel (center) ───────────────────────────────────────────────────
function EditorFileTabs({ title }: { title: string }) {
  return (
    <div style={{
      height: FILETAB_H,
      background: CW_BG_SECONDARY,
      borderBottom: `1px solid ${CW_BORDER}`,
      display: 'flex', alignItems: 'flex-end',
      paddingLeft: 0, flexShrink: 0,
    }}>
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center',
        paddingLeft: 14, paddingRight: 10, gap: 8,
        background: CW_BG_PRIMARY,
        borderTop: `2px solid ${CW_ACCENT}`,
        borderRight: `1px solid ${CW_BORDER}`,
        borderBottom: 'none',
      }}>
        <span style={{ fontFamily: SANS, fontSize: 13, color: CW_TEXT }}>{title}</span>
        <span style={{ fontFamily: SANS, fontSize: 12, color: CW_TEXT_FAINT }}>×</span>
      </div>
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center',
        paddingLeft: 14, paddingRight: 10, gap: 8,
        color: CW_TEXT_FAINT,
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </div>
    </div>
  )
}

function SpecContent() {
  const h2 = (text: string) => (
    <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: CW_TEXT, marginTop: 24, marginBottom: 10 }}>{text}</div>
  )
  const p = (text: string | React.ReactNode) => (
    <p style={{ fontFamily: SERIF, fontSize: 15, color: CW_TEXT_MUTED, lineHeight: 1.7, marginBottom: 10, marginTop: 0 }}>{text}</p>
  )
  const li = (text: string | React.ReactNode) => (
    <li style={{ fontFamily: SERIF, fontSize: 15, color: CW_TEXT_MUTED, lineHeight: 1.7, marginBottom: 4 }}>{text}</li>
  )
  const code = (text: string) => (
    <code style={{ fontFamily: MONO, fontSize: 13, background: 'rgba(229,229,226,0.07)', padding: '1px 5px', borderRadius: 3, color: CW_ACCENT }}>{text}</code>
  )

  return (
    <div style={{ padding: '28px 40px', overflow: 'hidden', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 700, color: CW_TEXT, marginBottom: 6 }}>
        claude-threads-spec
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12, color: CW_TEXT_FAINT, marginBottom: 28 }}>
        v0.1.31 · desktop only · requires Claude Code CLI
      </div>

      {h2('Overview')}
      {p('Claude Threads embeds Claude Code directly in your Obsidian sidebar. Each tab is an independent Claude Code session — not a wrapper with its own LLM calls, but the actual CLI running as a subprocess. Everything you\'ve already configured comes along.')}

      {h2('Prerequisites')}
      <ul style={{ paddingLeft: 20, margin: '0 0 16px' }}>
        {li(<>Obsidian v1.0.0+ (desktop only)</>)}
        {li(<>{code('claude')} CLI installed and authenticated (<code style={{ fontFamily: MONO, fontSize: 13, color: CW_TEXT_FAINT }}>claude --version</code> should work)</>)}
        {li(<>AWS Bedrock users: set {code('AWS_PROFILE')} and {code('AWS_REGION')} in Extra Env Vars</>)}
      </ul>

      {h2('Install via BRAT')}
      <ol style={{ paddingLeft: 20, margin: '0 0 16px' }}>
        {li('Install BRAT from the Community Plugins directory')}
        {li(<>BRAT settings → Add Beta Plugin → {code('richardbowman/obsidian-claude-threads')}</>)}
        {li('Enable Claude Threads in Settings → Community Plugins')}
      </ol>

      {h2('Key Features')}
      <ul style={{ paddingLeft: 20, margin: '0 0 8px' }}>
        {li('Multi-tab sessions — each thread has its own cwd and conversation history')}
        {li('Slash commands — type / to browse your ~/.claude/skills/ library')}
        {li('Streaming markdown — tokens render live with code blocks, tables, lists')}
        {li('Agent Dashboard — monitor all threads, dispatch from one view')}
        {li('Permission dialogs — Deny / Allow / Always Allow for file writes')}
      </ul>
    </div>
  )
}

function EditorPanel({ title, scene }: { title: string; scene: number }) {
  return (
    <div style={{
      width: EDITOR_W, height: '100%', background: CW_BG_PRIMARY,
      display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${CW_BORDER}`,
    }}>
      <EditorFileTabs title={title} />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <SpecContent />
      </div>
    </div>
  )
}

// ─── Agent Dashboard panel (right) ───────────────────────────────────────────
// working=true  → shows accent dot + live activity line (current tool call)
// working=false → shows checkmark + full summary paragraph (auto-generated)
function DashThreadItem({ title, activity, summary, timestamp, cwd, working = false }: {
  title: string
  activity?: string   // running threads: live tool call text
  summary?: string    // idle threads: auto-generated summary paragraph
  timestamp: string
  cwd?: string
  working?: boolean
}) {
  return (
    <div style={{
      padding: '8px 14px 9px',
      borderBottom: `1px solid ${CW_BORDER}`,
      background: working ? 'rgba(234,146,138,0.04)' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        {/* State icon */}
        <div style={{ paddingTop: 3, flexShrink: 0, width: 14, display: 'flex', justifyContent: 'center' }}>
          {working
            ? <div style={{ width: 7, height: 7, borderRadius: 4, background: CW_ACCENT, marginTop: 1 }} />
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={CW_SUCCESS} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title row + timestamp */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6, marginBottom: 2 }}>
            <span style={{
              fontFamily: SANS, fontSize: 12.5, fontWeight: 500,
              color: working ? CW_TEXT : CW_TEXT_MUTED,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{title}</span>
            <span style={{ fontFamily: SANS, fontSize: 10.5, color: CW_TEXT_FAINT, flexShrink: 0 }}>{timestamp}</span>
          </div>
          {/* Summary — multi-line, shown for idle threads */}
          {summary && !working && (
            <div style={{
              fontFamily: SANS, fontSize: 11, color: CW_TEXT_FAINT,
              lineHeight: 1.45, marginBottom: cwd ? 3 : 0,
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>{summary}</div>
          )}
          {/* Activity — single line, shown for running threads */}
          {activity && working && (
            <div style={{
              fontFamily: MONO, fontSize: 10.5, color: CW_TEXT_FAINT,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{activity}</div>
          )}
          {/* cwd path */}
          {cwd && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: CW_TEXT_FAINT, opacity: 0.7, marginTop: 2 }}>{cwd}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentDashboard({ scene }: { scene: number }) {
  return (
    <div style={{
      width: DASH_W, height: '100%', background: CW_BG_PRIMARY,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header — matches Obsidian file tab bar height */}
      <div style={{
        height: FILETAB_H,
        background: CW_BG_SECONDARY,
        borderBottom: `1px solid ${CW_BORDER}`,
        display: 'flex', alignItems: 'center',
        paddingLeft: 14, paddingRight: 14, gap: 8, flexShrink: 0,
      }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={CW_TEXT_MUTED} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M12 14c-4.97 0-9 2.015-9 4.5V21h18v-2.5c0-2.485-4.03-4.5-9-4.5z"/>
        </svg>
        <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: CW_TEXT }}>Agent Dashboard</span>
        <span style={{ fontFamily: SANS, fontSize: 11.5, color: CW_TEXT_FAINT, marginLeft: 4 }}>
          {scene === 2 ? '2 running · 6 total' : '1 running · 6 total'}
        </span>
      </div>

      {/* Thread list */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {/* Working section */}
        <div style={{
          padding: '8px 14px 4px',
          fontFamily: SANS, fontSize: 11, fontWeight: 600,
          color: CW_TEXT_FAINT, letterSpacing: '0.06em',
          borderBottom: `1px solid ${CW_BORDER}`,
        }}>WORKING</div>

        <DashThreadItem
          working
          title={scene === 2 ? 'Reddit launch — r/ObsidianMD post' : 'Review claude-threads-spec'}
          activity={scene === 2 ? 'Read: Claude/linkedin-content-calendar.md' : 'Bash: grep -n "install" README.md'}
          timestamp="just now"
          cwd="~/projects/obsidian-claude-threads"
        />

        {scene === 2 && (
          <DashThreadItem
            working
            title="Update spec prereqs section"
            activity="Edit: Claude/claude-threads-spec.md"
            timestamp="12s ago"
            cwd="~/projects/obsidian-claude-threads"
          />
        )}

        {/* Completed section */}
        <div style={{
          padding: '8px 14px 4px', marginTop: 4,
          fontFamily: SANS, fontSize: 11, fontWeight: 600,
          color: CW_TEXT_FAINT, letterSpacing: '0.06em',
          borderBottom: `1px solid ${CW_BORDER}`,
        }}>COMPLETED</div>

        <DashThreadItem
          title="Reddit marketing plan"
          summary="Drafted a full r/ObsidianMD post for the Claude Threads launch. Covers the subprocess approach, slash command skills integration, and agent dashboard. Includes BRAT install steps and honest beta caveat."
          timestamp="2m ago"
          cwd="~/projects/obsidian-claude-threads"
        />
        <DashThreadItem
          title="Stop button context fix"
          summary="Fixed destructive behavior when stop is pressed mid-generation. Conversation history is now preserved and the next prompt continues the thread rather than starting fresh."
          timestamp="18m ago"
          cwd="~/projects/obsidian-claude-threads"
        />
        <DashThreadItem
          title="UI Polish — Phase 1"
          summary="Applied CSS-only fixes across the plugin: eliminated thread info bar dead space, replaced all hardcoded 10px/11px sizes with var(--font-ui-smaller), refined streaming cursor to a slim animated bar."
          timestamp="1h ago"
          cwd="~/projects/obsidian-claude-threads"
        />
        <DashThreadItem
          title="Add tab sync on dashboard click"
          summary="Resolved mismatch where clicking a thread in the Agent Dashboard didn't highlight the correct tab in the conversation view. Tab selection now stays in sync across both views."
          timestamp="2h ago"
          cwd="~/projects/obsidian-claude-threads"
        />
      </div>

      {/* Dispatch input */}
      <div style={{
        borderTop: `1px solid ${CW_BORDER}`,
        padding: '10px 14px 8px',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <div style={{
            flex: 1,
            background: CW_FORM_FIELD,
            borderRadius: 6, border: `1px solid ${CW_BORDER}`,
            padding: '7px 10px',
            fontFamily: SANS, fontSize: 13, color: CW_TEXT_FAINT,
          }}>Dispatch a task… (Enter to start, Shift+Enter for newline)</div>
          <button style={{
            background: CW_ACCENT, color: CW_ON_ACCENT,
            border: 'none', borderRadius: 6, padding: '7px 14px',
            fontFamily: SANS, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Start</button>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={CW_TEXT_FAINT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={CW_TEXT_FAINT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
      </div>
    </div>
  )
}

// ─── Scene 4: CT panel background for permission scene ───────────────────────
function CTPanel_Permission() {
  return (
    <div style={{
      width: CT_W, background: CT_BG, height: '100%',
      display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${CT_BORDER}`,
    }}>
      <CTTabBar activeIdx={0} />
      <div style={{
        padding: '5px 12px', background: CT_CARD,
        borderBottom: `1px solid ${CT_BORDER}`,
        fontFamily: SANS, fontSize: 11.5, color: CT_MUTED,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={CT_MUTED} strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
        <span>Refactoring permission handler</span>
        <div style={{ marginLeft: 'auto' }}>
          <span style={{
            fontFamily: MONO, fontSize: 10.5,
            background: 'rgba(88,166,255,0.12)', border: `1px solid rgba(88,166,255,0.2)`,
            borderRadius: 4, padding: '1px 6px', color: CT_BLUE,
          }}>sonnet</span>
        </div>
      </div>
      <div style={{ flex: 1, padding: '14px 12px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <CTMessage role="user" content="Can you refactor the permission handler to support per-tool allowlist entries and persist them across restarts?" />
        <CTMessage
          role="assistant"
          toolCalls={[
            { icon: '📖', text: 'Read: src/ThreadsView.ts' },
            { icon: '📖', text: 'Read: src/types.ts' },
          ]}
          content="Got it — I'll add a per-tool allowlist to the settings schema and wire it into the handler. Updating ThreadsView.ts now."
        />
        {/* Pending tool call row — Claude is waiting for permission */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '5px 9px', background: 'rgba(234,146,138,0.07)',
          borderRadius: 6, border: `1px solid rgba(234,146,138,0.2)`,
          marginTop: 4,
        }}>
          <span style={{ fontSize: 11 }}>✏️</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: CW_ACCENT, flex: 1 }}>Edit: src/ThreadsView.ts</span>
          <span style={{ fontFamily: SANS, fontSize: 10, color: CW_ACCENT, opacity: 0.8 }}>waiting…</span>
        </div>
      </div>
      <CTInputBar />
    </div>
  )
}

// ─── Obsidian permission modal overlay ───────────────────────────────────────
const CW_MODAL_BG      = '#303030'   // --background-primary-alt (dark)
const CW_BTN_NORMAL    = '#343533'   // --interactive-normal
const CW_DANGER_BG     = 'rgba(234,146,138,0.12)'
const CW_DANGER_BORDER = 'rgba(234,146,138,0.35)'
const CW_DANGER_TEXT   = '#f2a29a'   // --text-error

function PermissionModal() {
  const btnBase: React.CSSProperties = {
    fontFamily: SANS, fontSize: 13.5, fontWeight: 500,
    padding: '7px 16px', borderRadius: 8,
    border: 'none', cursor: 'pointer',
  }
  return (
    /* Full-content overlay — sits on top of the 3-panel layout */
    <div style={{
      position: 'absolute', inset: 0,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100,
    }}>
      <div style={{
        background: CW_MODAL_BG,
        border: `1px solid ${CW_BORDER}`,
        borderRadius: 16,
        boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        padding: '24px 28px 20px',
        width: 420,
        display: 'flex', flexDirection: 'column', gap: 0,
      }}>
        {/* Title — tool name */}
        <div style={{
          fontFamily: SANS, fontSize: 17, fontWeight: 600,
          color: CW_TEXT, marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 18 }}>✏️</span>
          str_replace_editor
        </div>

        {/* Detail */}
        <div style={{
          fontFamily: SANS, fontSize: 13.5, color: CW_TEXT_MUTED,
          lineHeight: 1.55, marginBottom: 20,
        }}>
          Claude wants to edit{' '}
          <code style={{
            fontFamily: MONO, fontSize: 12.5,
            background: 'rgba(229,229,226,0.08)', padding: '1px 6px',
            borderRadius: 4, color: CW_TEXT,
          }}>src/ThreadsView.ts</code>
          {' '}— update the permission handler to support per-tool allowlist entries (lines 100–125).
        </div>

        {/* Button row */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={{
            ...btnBase,
            background: CW_DANGER_BG,
            border: `1px solid ${CW_DANGER_BORDER}`,
            color: CW_DANGER_TEXT,
          }}>Deny</button>
          <button style={{
            ...btnBase,
            background: CW_BTN_NORMAL,
            border: `1px solid ${CW_BORDER}`,
            color: CW_TEXT,
          }}>Allow</button>
          <button style={{
            ...btnBase,
            background: CW_ACCENT,
            color: CW_ON_ACCENT,
          }}>Always Allow</button>
        </div>
      </div>
    </div>
  )
}

// ─── Layout constants for floating window ────────────────────────────────────
const MARGIN  = 28                       // desktop padding around window
const WIN_W   = 1920 - MARGIN * 2       // 1864
const WIN_H   = 1080 - MARGIN * 2       // 1024
const SCALE   = 1.25                    // zoom: content × 1.25 fills window exactly

// ─── Main composition ─────────────────────────────────────────────────────────
export function ClaudeThreadsShots() {
  const frame = useCurrentFrame()
  const scene = frame < 60 ? 0 : frame < 120 ? 1 : frame < 180 ? 2 : 3

  const ctPanel = scene === 0
    ? <CTPanel_Main />
    : scene === 1
    ? <CTPanel_Slash />
    : scene === 2
    ? <CTPanel_Stream />
    : <CTPanel_Permission />

  const editorTitle = scene === 0
    ? 'claude-threads-spec'
    : scene === 1
    ? 'HipTrip-user-interviews.md'
    : scene === 2
    ? 'claude-threads-reddit-marketing'
    : 'ThreadsView.ts'

  return (
    <AbsoluteFill style={{
      background: [
        'radial-gradient(ellipse at 78% 10%, rgba(234,146,138,0.55) 0%, transparent 40%)',
        'radial-gradient(ellipse at 15% 90%, rgba(139,92,246,0.70) 0%, transparent 44%)',
        'radial-gradient(ellipse at 52% 52%, rgba(88,166,255,0.15) 0%, transparent 60%)',
        'linear-gradient(148deg, #110e09 0%, #1a1410 55%, #0c0a07 100%)',
      ].join(', '),
    }}>
      {/* Floating macOS window */}
      <div style={{
        position: 'absolute',
        top: MARGIN, left: MARGIN,
        width: WIN_W, height: WIN_H,
        borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 36px 90px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.07)',
      }}>
        {/* Scale content down to fit inside the window bounds */}
        <div style={{
          width: W, height: H,
          zoom: SCALE,
          display: 'flex', flexDirection: 'column',
          position: 'relative',
        }}>
          <TitleBar />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
            {ctPanel}
            <EditorPanel title={editorTitle} scene={scene} />
            <AgentDashboard scene={scene} />
          </div>
          <StatusBar />
          {/* Permission modal overlay — scene 3 only */}
          {scene === 3 && <PermissionModal />}
        </div>
      </div>
    </AbsoluteFill>
  )
}
