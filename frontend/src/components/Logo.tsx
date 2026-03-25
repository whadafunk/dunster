export function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* TV body */}
      <rect x="1" y="4" width="28" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.8"/>
      {/* TV stand */}
      <line x1="10" y1="23" x2="8"  y2="28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="20" y1="23" x2="22" y2="28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="6"  y1="28" x2="24" y2="28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      {/* Download arrow — shaft */}
      <line x1="15" y1="8" x2="15" y2="17" stroke="#e8ff47" strokeWidth="2.2" strokeLinecap="round"/>
      {/* Download arrow — head */}
      <polyline points="10.5,13.5 15,18 19.5,13.5" stroke="#e8ff47" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
