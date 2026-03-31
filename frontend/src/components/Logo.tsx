export function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* TV body */}
      <rect x="1" y="4" width="28" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.8"/>
      {/* TV stand */}
      <line x1="10" y1="23" x2="8"  y2="28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="20" y1="23" x2="22" y2="28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="6"  y1="28" x2="24" y2="28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      {/* Lightning bolt */}
      <polygon points="18,6 10,15 15,15 12,21 20,13 15,13" fill="#f0ff80" />
    </svg>
  )
}
