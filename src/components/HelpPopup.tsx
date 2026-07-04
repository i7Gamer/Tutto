import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { HelpCircle, X, ChevronRight, ChevronDown } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';

interface SectionProps {
  title: string;
  id: string;
  isOpen: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

function Section({ title, id, isOpen, onToggle, children }: SectionProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (isOpen && contentRef.current) {
      contentRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isOpen]);

  return (
    <div className="mb-3 sm:mb-4 bg-gray-50 dark:bg-slate-800 rounded-lg sm:rounded-xl overflow-hidden border border-gray-100 dark:border-slate-700">
      <button
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between px-3 py-3 sm:px-4 sm:py-4 bg-white dark:bg-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
      >
        <span className="text-base sm:text-lg leading-none font-bold text-gray-800 dark:text-gray-100 pt-0.5">{title}</span>
        {isOpen ? <ChevronDown size={20} className="text-gray-500 flex-shrink-0" /> : <ChevronRight size={20} className="text-gray-500 flex-shrink-0" />}
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-gray-100 dark:border-slate-700"
          >
            <div ref={contentRef} className="p-3 sm:p-4 text-sm sm:text-base text-gray-600 dark:text-gray-300 space-y-3">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function HelpPopup() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const gameState = useGameStore(state => state.gameState);
  
  const [activeSection, setActiveSection] = useState<string>('general');

  // When opening during gameplay, check if we have a current card
  useEffect(() => {
    if (isOpen && gameState?.status === 'PLAYING' && gameState.currentCard) {
      setActiveSection('cards');
    }
  }, [isOpen, gameState?.status, gameState?.currentCard]);

  const toggleSection = (id: string) => {
    setActiveSection(prev => prev === id ? '' : id);
  };

  const tocSections = [
    { id: 'general', label: t('help.toc.general', 'General Rules') },
    { id: 'cards', label: t('help.toc.cards', 'Cards') },
    { id: 'settings', label: t('help.toc.settings', 'Settings') },
    { id: 'statistics', label: t('help.toc.statistics', 'Statistics') },
    { id: 'faq', label: t('help.toc.faq', 'FAQ') },
  ];

  const faqs = [
    { q: t('help.faq.q1'), a: t('help.faq.a1') },
    { q: t('help.faq.q2'), a: t('help.faq.a2') },
    { q: t('help.faq.q3'), a: t('help.faq.a3') },
    { q: t('help.faq.q4'), a: t('help.faq.a4') },
    { q: t('help.faq.q5'), a: t('help.faq.a5') },
    { q: t('help.faq.q6'), a: t('help.faq.a6') },
    { q: t('help.faq.q7'), a: t('help.faq.a7') },
  ];

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 left-6 w-12 h-12 bg-white dark:bg-slate-800 rounded-full shadow-lg flex items-center justify-center hover:scale-110 transition-transform z-50 text-indigo-500 dark:text-indigo-400 border border-gray-100 dark:border-slate-700"
        title={t('help.buttonTitle', 'Open Help / Wiki')}
      >
        <HelpCircle size={24} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6" onClick={() => setIsOpen(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white dark:bg-slate-900 rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl border border-gray-100 dark:border-slate-700"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="relative flex items-center justify-center p-4 sm:p-6 border-b border-gray-100 dark:border-slate-800">
                <h2 className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                  <HelpCircle className="text-indigo-500 w-5 h-5 sm:w-6 sm:h-6" />
                  {t('help.title', 'Tutto Wiki')}
                </h2>
                <button
                  onClick={() => setIsOpen(false)}
                  className="absolute right-4 sm:right-6 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 bg-gray-100 dark:bg-slate-800 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                  title={t('help.close', 'Close')}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 scroll-smooth">
                {/* Table of Contents - Horizontal Pills for quick nav */}
                <div className="flex flex-wrap gap-2 mb-6 sm:mb-8">
                  <span className="text-sm font-semibold text-gray-500 dark:text-gray-400 py-2 mr-2">
                    {t('help.toc.title', 'Table of Contents')}:
                  </span>
                  {tocSections.map((section) => (
                    <button
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      className={`px-4 pt-[0.6rem] pb-[0.4rem] rounded-full text-sm font-medium transition-colors leading-none ${
                        activeSection === section.id
                          ? 'bg-indigo-500 text-white'
                          : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-700'
                      }`}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>

                {/* Sections */}
                <Section id="general" title={t('help.general.title', 'General Rules')} isOpen={activeSection === 'general'} onToggle={toggleSection}>
                  <p>{t('help.general.intro')}</p>
                  <h4 className="font-bold text-gray-800 dark:text-gray-200 mt-4">{t('help.general.turnFlowTitle')}</h4>
                  <div className="space-y-3">
                    <div>
                      <span className="font-semibold text-gray-800 dark:text-gray-200">{t('help.general.step1Title')}</span> {t('help.general.step1Desc')}
                    </div>
                    <div>
                      <span className="font-semibold text-gray-800 dark:text-gray-200">{t('help.general.step2Title')}</span> {t('help.general.step2Desc')}
                    </div>
                    <div>
                      <span className="font-semibold text-gray-800 dark:text-gray-200">{t('help.general.step3Title')}</span> {t('help.general.step3Desc')}
                    </div>
                    <div>
                      <span className="font-semibold text-gray-800 dark:text-gray-200">{t('help.general.step4Title')}</span> {t('help.general.step4Desc')}
                      <ul className="list-disc pl-5 mt-1 space-y-1">
                        <li><span className="font-semibold">{t('help.general.step4aTitle')}</span> {t('help.general.step4aDesc')}</li>
                        <li><span className="font-semibold">{t('help.general.step4bTitle')}</span> {t('help.general.step4bDesc')}</li>
                      </ul>
                    </div>
                    <div>
                      <span className="font-semibold text-gray-800 dark:text-gray-200">{t('help.general.step5Title')}</span> {t('help.general.step5Desc')}
                    </div>
                  </div>
                </Section>

                <Section id="cards" title={t('help.cards.title', 'Cards')} isOpen={activeSection === 'cards'} onToggle={toggleSection}>
                  <div className="space-y-4">
                    <div className={gameState?.currentCard?.type === 'bonus' ? 'ring-2 ring-indigo-500 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20' : ''}>
                      <h4 className="font-bold text-gray-800 dark:text-gray-200">{t('help.cards.bonus', 'Bonus (200 - 600)')}</h4>
                      <p className="text-sm">{t('help.cards.bonusDesc')}</p>
                    </div>
                    <div className={gameState?.currentCard?.type === 'x2' ? 'ring-2 ring-indigo-500 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20' : ''}>
                      <h4 className="font-bold text-gray-800 dark:text-gray-200">{t('help.cards.x2', 'x2 (Double)')}</h4>
                      <p className="text-sm">{t('help.cards.x2Desc')}</p>
                    </div>
                    <div className={gameState?.currentCard?.type === 'stop' ? 'ring-2 ring-indigo-500 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20' : ''}>
                      <h4 className="font-bold text-gray-800 dark:text-gray-200">{t('help.cards.stop', 'Stop')}</h4>
                      <p className="text-sm">{t('help.cards.stopDesc')}</p>
                    </div>
                    <div className={gameState?.currentCard?.type === 'fireworks' ? 'ring-2 ring-indigo-500 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20' : ''}>
                      <h4 className="font-bold text-gray-800 dark:text-gray-200">{t('help.cards.fireworks', 'Fireworks')}</h4>
                      <p className="text-sm border-l-2 border-orange-400 pl-3 mt-1 italic text-orange-800 dark:text-orange-200" dangerouslySetInnerHTML={{ __html: t('help.cards.fireworksDesc').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }}></p>
                    </div>
                    <div className={gameState?.currentCard?.type === 'kniffel' ? 'ring-2 ring-indigo-500 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20' : ''}>
                      <h4 className="font-bold text-gray-800 dark:text-gray-200">{t('help.cards.kniffel', 'Kniffel')}</h4>
                      <p className="text-sm border-l-2 border-indigo-400 pl-3 mt-1 italic text-indigo-800 dark:text-indigo-200" dangerouslySetInnerHTML={{ __html: t('help.cards.kniffelDesc').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }}></p>
                    </div>
                    <div className={gameState?.currentCard?.type === 'plusMinus' ? 'ring-2 ring-indigo-500 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20' : ''}>
                      <h4 className="font-bold text-gray-800 dark:text-gray-200">{t('help.cards.plusMinus', 'Plus/Minus')}</h4>
                      <p className="text-sm border-l-2 border-red-400 pl-3 mt-1 italic text-red-800 dark:text-red-200" dangerouslySetInnerHTML={{ __html: t('help.cards.plusMinusDesc').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }}></p>
                    </div>
                    <div className={gameState?.currentCard?.type === 'kleeblatt' ? 'ring-2 ring-indigo-500 p-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20' : ''}>
                      <h4 className="font-bold text-gray-800 dark:text-gray-200">{t('help.cards.kleeblatt', 'Kleeblatt')}</h4>
                      <p className="text-sm border-l-2 border-green-400 pl-3 mt-1 italic text-green-800 dark:text-green-200" dangerouslySetInnerHTML={{ __html: t('help.cards.kleeblattDesc').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }}></p>
                    </div>
                  </div>
                </Section>

                <Section id="settings" title={t('help.settings.title', 'Settings')} isOpen={activeSection === 'settings'} onToggle={toggleSection}>
                  <ul className="list-disc pl-5 space-y-2">
                    <li>{t('help.settings.winningScore')}</li>
                    <li>{t('help.settings.turnTimer')}</li>
                    <li>{t('help.settings.kickTimer')}</li>
                    <li>{t('help.settings.randomOrder')}</li>
                    <li>{t('help.settings.diceMode')}</li>
                    <li>{t('help.settings.deckComp')}</li>
                  </ul>
                </Section>

                <Section id="statistics" title={t('help.statistics.title', 'Statistics')} isOpen={activeSection === 'statistics'} onToggle={toggleSection}>
                  <ul className="list-disc pl-5 space-y-2">
                    <li>{t('help.statistics.s1')}</li>
                    <li>{t('help.statistics.s2')}</li>
                    <li>{t('help.statistics.s3')}</li>
                    <li>{t('help.statistics.s4')}</li>
                    <li>{t('help.statistics.s5')}</li>
                    <li>{t('help.statistics.s6')}</li>
                  </ul>
                </Section>

                <Section id="faq" title={t('help.faq.title', 'FAQ')} isOpen={activeSection === 'faq'} onToggle={toggleSection}>
                  <div className="space-y-4">
                    {faqs.map((faq, idx) => (
                      <div key={`faq-${idx}`}>
                        <h4 className="font-bold text-gray-800 dark:text-gray-200">{faq.q}</h4>
                        <p className="text-sm mt-1">{faq.a}</p>
                      </div>
                    ))}
                  </div>
                </Section>

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
