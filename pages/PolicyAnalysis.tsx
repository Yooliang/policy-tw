import React, { useState, useMemo } from 'react';
import { POLICIES, CANDIDATES } from '../constants';
import { PolicyStatus } from '../types';
import Hero from '../components/Hero';
import { Search, GitBranch, Sparkles, Database, Milestone, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const PolicyAnalysis: React.FC = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');

  const relayCases = useMemo(() => {
    const cases: any[] = [];
    const visitedPolicyIds = new Set<string>();

    POLICIES.forEach(policy => {
      if (visitedPolicyIds.has(policy.id)) return;
      if (policy.relatedPolicyIds && policy.relatedPolicyIds.length > 0) {
        const chain = POLICIES.filter(p => p.id === policy.id || policy.relatedPolicyIds?.includes(p.id) || p.relatedPolicyIds?.includes(policy.id))
          .sort((a, b) => new Date(a.proposedDate).getTime() - new Date(b.proposedDate).getTime());
        chain.forEach(p => visitedPolicyIds.add(p.id));
        cases.push({
          id: `case-${policy.id}`,
          mainTitle: policy.title.includes('園區') ? '高屏產業聚落接力案' : policy.title,
          category: policy.category,
          policies: chain,
          involvedCandidateIds: [...new Set(chain.map(p => p.candidateId))],
          startYear: chain[0].proposedDate.split('-')[0],
          lastYear: '2026',
          totalProgress: Math.round(chain.reduce((acc, p) => acc + p.progress, 0) / chain.length),
          isRelay: true
        });
      } else if (policy.status !== PolicyStatus.CAMPAIGN && policy.progress > 50) {
        visitedPolicyIds.add(policy.id);
        cases.push({
          id: `case-${policy.id}`,
          mainTitle: policy.title,
          category: policy.category,
          policies: [policy],
          involvedCandidateIds: [policy.candidateId],
          startYear: policy.proposedDate.split('-')[0],
          lastYear: '2026',
          totalProgress: policy.progress,
          isRelay: false
        });
      }
    });
    return cases.filter(c => c.mainTitle.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [searchTerm]);

  return (
    <div className="bg-slate-50 min-h-screen pb-20 text-left">
      <Hero 
        title="AI 市政治理智能分析"
        description={<>這不是單一政見的陳列。我們將跨任期、跨黨派的重大建設案進行聚合，<br className="hidden lg:block" />分析每一根治理接力棒的傳承品質，提供具備行政歷史深度的稽核數據。</>}
        icon={<Database size={400} className="text-blue-500" />}
      >
        <div className="bg-white p-6 rounded-2xl shadow-2xl border border-slate-200 w-full">
          <div className="relative text-left">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
            <input 
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜尋重大建設案（如：產業園區、捷運建設）..."
              className="w-full pl-12 pr-4 py-3 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-blue-500 text-navy-900 font-bold"
            />
          </div>
        </div>
      </Hero>

      <div className="max-w-7xl mx-auto px-4 pt-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {relayCases.map(relayCase => (
            <div key={relayCase.id} onClick={() => navigate(`/analysis/${relayCase.policies[relayCase.policies.length - 1].id}`)} className="group bg-white rounded-[32px] border border-slate-200 shadow-sm hover:shadow-2xl hover:border-blue-400 transition-all duration-500 cursor-pointer overflow-hidden flex flex-col">
              <div className="p-8 flex-1">
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-2">
                     <div className="p-3 bg-navy-900 text-white rounded-2xl shadow-lg"><Milestone size={24} /></div>
                     <span className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">Case Study</span>
                  </div>
                  {relayCase.isRelay && (
                    <div className="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-[10px] font-black border border-blue-100 uppercase animate-pulse">
                      <GitBranch size={12} /> 市政接力 Relay
                    </div>
                  )}
                </div>
                <h3 className="text-2xl font-black text-navy-900 mb-4 group-hover:text-blue-600 transition-colors leading-tight">{relayCase.mainTitle}</h3>
                <p className="text-slate-500 text-sm leading-relaxed mb-8 line-clamp-2 font-medium">{relayCase.policies[0].description}</p>
                <div className="mb-8">
                   <div className="flex justify-between text-[10px] font-black text-slate-400 mb-3 uppercase tracking-widest">
                      <span>{relayCase.startYear} 啟動</span>
                      <span>2026 預計願景</span>
                   </div>
                   <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden flex">
                      <div className="h-full bg-blue-600 rounded-full shadow-lg shadow-blue-500/20 transition-all duration-1000" style={{ width: `${relayCase.totalProgress}%` }}></div>
                   </div>
                </div>
                <div className="flex items-center justify-between pt-6 border-t border-slate-50">
                   <div className="flex -space-x-3">
                      {relayCase.involvedCandidateIds.map((cid: string) => {
                        const c = CANDIDATES.find(can => can.id === cid);
                        return <img key={cid} src={c?.avatarUrl} className="w-12 h-12 rounded-full border-4 border-white shadow-md group-hover:scale-110 transition-all" title={c?.name} />;
                      })}
                   </div>
                   <div className="text-right">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">參與首長</div>
                      <div className="text-sm font-black text-navy-900">{relayCase.involvedCandidateIds.length} 位市政接棒者</div>
                   </div>
                </div>
              </div>
              <div className="px-8 py-5 bg-slate-50 group-hover:bg-blue-600 transition-colors flex justify-between items-center border-t border-slate-100">
                <span className="text-xs font-black text-slate-500 group-hover:text-white uppercase tracking-widest">進入深度審計詳情 Deep Audit</span>
                <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-navy-900 shadow-md group-hover:translate-x-1 transition-all"><ArrowRight size={18} /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PolicyAnalysis;