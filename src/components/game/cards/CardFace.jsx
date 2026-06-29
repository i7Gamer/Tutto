import './card.css';

const DICE_PATTERNS = {
  1: [0,0,0, 0,1,0, 0,0,0],
  2: [1,0,0, 0,0,0, 0,0,1],
  3: [1,0,0, 0,1,0, 0,0,1],
  4: [1,0,1, 0,0,0, 1,0,1],
  5: [1,0,1, 0,1,0, 1,0,1],
  6: [1,0,1, 1,0,1, 1,0,1],
};

function DieFace({ value }) {
  return (
    <div className="die-face">
      {DICE_PATTERNS[value].map((hasDot, i) => (
        <b key={i}>{hasDot ? <i /> : null}</b>
      ))}
    </div>
  );
}

function Die({ value }) {
  return (
    <div className="d-w">
      <DieFace value={value} />
    </div>
  );
}

function DiceGrid() {
  return (
    <div className="grd">
      <Die value={6} /><Die value={5} />
      <Die value={4} /><Die value={3} />
      <Die value={2} /><Die value={1} />
    </div>
  );
}

function Kniffel() {
  return (
    <>
      <div className="g" style={{left:'50%',top:'56%',width:'80%',height:'62%',background:'radial-gradient(circle, rgba(240,86,74,.5) 0%, transparent 68%)',opacity:.6}} />
      <div className="overlay" />
      <div className="hdr">
        <div style={{justifySelf:'start'}}><div className="crn" /></div>
        <span className="val">2000</span>
        <div style={{justifySelf:'end'}}><div className="crn" /></div>
      </div>
      <div className="cnt">
        <div className="inr" style={{ overflow: 'visible' }}>
          <div className="stk" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
            <Die value={1} /><Die value={2} /><Die value={3} /><Die value={4} /><Die value={5} /><Die value={6} />
          </div>
        </div>
      </div>
    </>
  );
}

function Plus_Minus() {
  return (
    <>
      <div className="g" style={{left:'24%',top:'58%',width:'62%',height:'60%',background:'radial-gradient(circle, rgba(79,143,247,.5) 0%, transparent 66%)',opacity:.55}} />
      <div className="g" style={{left:'74%',top:'58%',width:'62%',height:'60%',background:'radial-gradient(circle, rgba(240,86,74,.5) 0%, transparent 66%)',opacity:.55}} />
      <div className="overlay" />
      <div className="hdr">
        <div style={{justifySelf:'start'}}><div className="crn crn-pm-l" /></div>
        <span className="val">1000</span>
        <div style={{justifySelf:'end'}}><div className="crn crn-pm-r" /></div>
      </div>
      <div className="cnt">
        <div className="inr">
          <div style={{position:'relative',width:'72%',height:'72%'}}>
            <div className="pa" style={{left:'31%',top:'33%',width:'48%',height:'48%'}}>
              <div className="v-bar b-grad" />
              <div className="h-bar b-grad" />
            </div>
            <div className="pa" style={{left:'68%',top:'69%',width:'48%',height:'48%'}}>
              <div className="h-bar r-grad" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function X2() {
  return (
    <>
      <div className="g" style={{left:'50%',top:'56%',width:'80%',height:'62%',background:'radial-gradient(circle, var(--tg) 0%, transparent 68%)',opacity:.55}} />
      <div className="overlay" />
      <div className="hdr">
        <div style={{justifySelf:'start'}}><div className="crn" /></div>
        <span className="val">×2</span>
        <div style={{justifySelf:'end'}}><div className="crn" /></div>
      </div>
      <div className="cnt">
        <div className="inr"><DiceGrid /></div>
      </div>
    </>
  );
}

function BonusCard({ value }) {
  return (
    <>
      <div className="g" style={{left:'50%',top:'56%',width:'80%',height:'62%',background:'radial-gradient(circle, var(--tg) 0%, transparent 68%)',opacity:.55}} />
      <div className="overlay" />
      <div className="hdr">
        <div style={{justifySelf:'start'}}><div className="crn" /></div>
        <div className="b-col">
          <span className="val" style={{lineHeight:'.86'}}>{value}</span>
          <span className="b-txt">Bonus</span>
        </div>
        <div style={{justifySelf:'end'}}><div className="crn" /></div>
      </div>
      <div className="cnt">
        <div className="inr"><DiceGrid /></div>
      </div>
    </>
  );
}

function Feuerwerk() {
  const cornerStars = (
    <div style={{position:'relative',width:'30px',height:'30px'}}>
      <div className="star s-gld s-dp" style={{left:'50%',top:'42%',width:'44%',height:'44%'}} />
      <div className="star s-grn"      style={{left:'23%',top:'30%',width:'30%',height:'30%'}} />
      <div className="star s-red"      style={{left:'76%',top:'33%',width:'28%',height:'28%'}} />
      <div className="dc" style={{left:'50%',top:'80%',width:'9%',height:'9%',background:'#84b3ff'}} />
      <div className="dc" style={{left:'37%',top:'69%',width:'8%',height:'8%',background:'#84b3ff'}} />
      <div className="dc" style={{left:'63%',top:'69%',width:'8%',height:'8%',background:'#ffd97a'}} />
    </div>
  );
  return (
    <>
      <div className="g" style={{left:'50%',top:'54%',width:'82%',height:'64%',background:'radial-gradient(circle, var(--tg) 0%, transparent 68%)',opacity:.55}} />
      <div className="overlay" />
      <div className="hdr">
        <div style={{justifySelf:'start'}}>{cornerStars}</div>
        <div style={{justifySelf:'center'}} />
        <div style={{justifySelf:'end'}}>{cornerStars}</div>
      </div>
      <div className="cnt">
        <div className="inr">
          <div style={{position:'relative',width:'100%',height:'100%'}}>
            <div className="dc" style={{left:'50%',top:'90%',width:'5%',height:'5%',background:'#ffd97a',boxShadow:'rgba(255,217,122,.8) 0 0 8px'}} />
            <div className="dc" style={{left:'44%',top:'78%',width:'4%',height:'4%',background:'#84b3ff'}} />
            <div className="dc" style={{left:'38%',top:'67%',width:'4%',height:'4%',background:'#84b3ff'}} />
            <div className="dc" style={{left:'31%',top:'56%',width:'4%',height:'4%',background:'#84b3ff'}} />
            <div className="dc" style={{left:'50%',top:'74%',width:'4%',height:'4%',background:'#ffd97a'}} />
            <div className="dc" style={{left:'50%',top:'62%',width:'4%',height:'4%',background:'#ffd97a'}} />
            <div className="dc" style={{left:'56%',top:'78%',width:'4%',height:'4%',background:'#ff8478'}} />
            <div className="dc" style={{left:'62%',top:'67%',width:'4%',height:'4%',background:'#ff8478'}} />
            <div className="dc" style={{left:'69%',top:'57%',width:'4%',height:'4%',background:'#ff8478'}} />
            <div className="star s-gld s-dp" style={{left:'50%',top:'13%',width:'26%',height:'26%'}} />
            <div className="star s-grn s-dp" style={{left:'33%',top:'26%',width:'18%',height:'18%'}} />
            <div className="star s-red s-dp" style={{left:'67%',top:'28%',width:'18%',height:'18%'}} />
            <div className="star s-blu s-dp" style={{left:'23%',top:'46%',width:'14%',height:'14%'}} />
            <div className="star s-gld s-dp" style={{left:'78%',top:'48%',width:'14%',height:'14%'}} />
            <div className="star s-wht s-dp" style={{left:'46%',top:'38%',width:'13%',height:'13%'}} />
            <div className="star s-grn s-dp" style={{left:'60%',top:'50%',width:'12%',height:'12%'}} />
          </div>
        </div>
      </div>
    </>
  );
}

function Kleeblatt() {
  const cornerClover = (
    <div style={{position:'relative',width:'28px',height:'28px'}}>
      <div className="stm" style={{top:'47%',width:'5%',height:'44%',borderRadius:'2px'}} />
      <div className="hl hl-1" /><div className="hl hl-2" />
      <div className="hl hl-3" /><div className="hl hl-4" />
    </div>
  );
  return (
    <>
      <div className="g" style={{left:'50%',top:'54%',width:'82%',height:'64%',background:'radial-gradient(circle, var(--tg) 0%, transparent 68%)',opacity:.5}} />
      <div className="overlay" />
      <div className="hdr">
        <div style={{justifySelf:'start'}}>{cornerClover}</div>
        <div style={{justifySelf:'center'}} />
        <div style={{justifySelf:'end'}}>{cornerClover}</div>
      </div>
      <div className="cnt">
        <div className="inr">
          <div style={{position:'relative',width:'62%',height:'62%'}}>
            <div className="stm" style={{top:'46%',width:'5%',height:'52%',borderRadius:'3px'}} />
            <div className="il il-1" /><div className="il il-2" />
            <div className="il il-3" /><div className="il il-4" />
            <div className="dc" style={{left:'50%',top:'48%',width:'13%',height:'13%',background:'radial-gradient(circle, #1b8048, #0f5c30)'}} />
          </div>
        </div>
      </div>
    </>
  );
}

function Stop() {
  return (
    <>
      <div className="g" style={{left:'50%',top:'54%',width:'82%',height:'64%',background:'radial-gradient(circle, var(--tg) 0%, transparent 68%)',opacity:.55}} />
      <div className="overlay" />
      <div className="hdr">
        <div style={{justifySelf:'start'}}><div className="crn" /></div>
        <div style={{justifySelf:'center'}} />
        <div style={{justifySelf:'end'}}><div className="crn" /></div>
      </div>
      <div className="cnt">
        <div className="inr">
          <div style={{position:'relative',width:'80%',height:'80%',display:'flex',alignItems:'center',justifyContent:'center'}}>
            <div className="d-w" style={{width:'54%'}}><DieFace value={5} /></div>
            <div className="ring" />
            <div className="cross" />
          </div>
        </div>
      </div>
    </>
  );
}

const CARD_COMPONENTS = {
  Kniffel:    () => <Kniffel />,
  Plus_Minus: () => <Plus_Minus />,
  x2:         () => <X2 />,
  200:        () => <BonusCard value="200" />,
  300:        () => <BonusCard value="300" />,
  400:        () => <BonusCard value="400" />,
  500:        () => <BonusCard value="500" />,
  600:        () => <BonusCard value="600" />,
  Feuerwerk:  () => <Feuerwerk />,
  Kleeblatt:  () => <Kleeblatt />,
  Stop:       () => <Stop />,
};

export default function CardFace({ cardType }) {
  const Content = CARD_COMPONENTS[cardType];
  if (!Content) return null;
  return (
    <div className={`tutto-card c-${cardType}`}>
      <Content />
    </div>
  );
}
