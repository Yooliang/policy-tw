import { Candidate, Election, Policy, PolicyStatus, PoliticalParty, ElectionType } from './types';

export { ELECTIONS, getElectionById, getActiveElection } from './constants';

export const CANDIDATES: Candidate[] = [
  {
    id: 'c0',
    name: '前任高雄市長',
    party: PoliticalParty.KMT,
    electionType: ElectionType.MAYOR,
    position: '前高雄市長',
    region: '高雄市',
    avatarUrl: 'https://ui-avatars.com/api/?name=Han&background=0D8ABC&color=fff',
    electionIds: [],
    bio: '曾任高雄市長，推動路平專案與初期產業園區規劃。',
  },
  {
    id: 'c1',
    name: '蔣萬安',
    party: PoliticalParty.KMT,
    electionType: ElectionType.MAYOR,
    position: '台北市長',
    region: '台北市',
    avatarUrl: 'https://picsum.photos/200/200?random=1',
    electionIds: ['election-2026'],
    slogan: '台北隊，出發！讓世界看見台北',
    bio: '現任台北市長，致力於打造服務型政府，推動都更、交通與智慧城市建設。',
    education: ['美國賓州大學法學博士', '國立政治大學外交學系'],
    experience: ['第10屆立法委員', '萬澤外國法事務律師事務所律師']
  },
  {
    id: 'c2',
    name: '侯友宜',
    party: PoliticalParty.KMT,
    electionType: ElectionType.MAYOR,
    position: '新北市長',
    region: '新北市',
    avatarUrl: 'https://picsum.photos/200/200?random=2',
    electionIds: [], 
    slogan: '好好做事，團結共好',
    bio: '警察出身，強調執行力與行政中立，推動新北 2030 願景工程。',
    education: ['中央警察大學犯罪防治研究所博士'],
    experience: ['新北市副市長', '內政部警政署署長', '中央警察大學校長']
  },
  {
    id: 'c3',
    name: '陳其邁',
    party: PoliticalParty.DPP,
    electionType: ElectionType.MAYOR,
    position: '高雄市長',
    region: '高雄市',
    avatarUrl: 'https://picsum.photos/200/200?random=3',
    electionIds: [],
    slogan: '緊緊緊，兩年拚四年',
    bio: '棄醫從政，致力於高雄產業轉型，引進半導體產業鏈與推動亞灣區發展。',
    education: ['國立台灣大學公共衛生碩士', '中山醫學院醫學系'],
    experience: ['行政院副院長', '立法委員', '總統府副秘書長']
  },
  {
    id: 'c4',
    name: '高虹安',
    party: PoliticalParty.TPP,
    electionType: ElectionType.MAYOR,
    position: '新竹市長',
    region: '新竹市',
    avatarUrl: 'https://picsum.photos/200/200?random=4',
    electionIds: ['election-2026'],
    slogan: '新竹 UPGRADE，科技新未來',
    bio: '科技背景出身，強調數據治理與科學決策，致力解決新竹交通與教育問題。',
    education: ['美國辛辛那提大學機械工程博士', '國立台灣大學資訊工程碩士'],
    experience: ['立法委員', '鴻海集團工業大數據辦公室主任']
  },
  {
    id: 'c5',
    name: '王小明',
    party: PoliticalParty.DPP,
    electionType: ElectionType.MAYOR,
    position: '台北市長參選人',
    region: '台北市',
    avatarUrl: 'https://picsum.photos/200/200?random=5',
    electionIds: ['election-2026'],
    slogan: '翻轉台北，居住正義',
    bio: '長期關注居住正義與都市規劃的學者，主張大膽改革社宅政策與都市更新。',
    education: ['國立台灣大學建築與城鄉研究所博士'],
    experience: ['居住正義聯盟 理事長', '台北市都市計畫委員']
  },
  {
    id: 'c6',
    name: '林大華',
    party: PoliticalParty.IND,
    electionType: ElectionType.MAYOR,
    position: '新竹市長參選人',
    region: '新竹市',
    avatarUrl: 'https://picsum.photos/200/200?random=6',
    electionIds: ['election-2026'],
    slogan: '超越藍綠，交通先行',
    bio: '交通工程專家，無黨派包袱，承諾用專業解決竹科塞車問題。',
    education: ['國立交通大學交通運輸研究所碩士'],
    experience: ['新竹科學園區 交通顧問', '民間交通改革協會 發起人']
  },
  {
    id: 'c7',
    name: '張熱血',
    party: PoliticalParty.TPP,
    electionType: ElectionType.COUNCILOR,
    position: '台北市議員參選人',
    region: '台北市',
    subRegion: '中山大同區',
    avatarUrl: 'https://ui-avatars.com/api/?name=Chang&background=0ea5e9&color=fff',
    electionIds: ['election-2026'],
    slogan: '監督市政，絕不放水',
    bio: '專注於交通改善與舊城區再生，強力監督市府預算執行。',
    education: ['國立政治大學公共行政碩士'],
    experience: ['國會助理', '社區發展協會 理事']
  },
  {
    id: 'c8',
    name: '陳在地',
    party: PoliticalParty.IND,
    electionType: ElectionType.COUNCILOR,
    position: '新竹市議員參選人',
    region: '新竹市',
    subRegion: '東區',
    avatarUrl: 'https://ui-avatars.com/api/?name=Chen&background=64748b&color=fff',
    electionIds: ['election-2026'],
    slogan: '為了孩子，守護新竹',
    bio: '全職媽媽參政，最懂親子需求，主打公園改造與教育資源分配。',
    education: ['國立清華大學社會學碩士'],
    experience: ['家長會長', '親子共學團 團長']
  },
  {
    id: 'c9',
    name: '李里長',
    party: PoliticalParty.IND,
    electionType: ElectionType.CHIEF,
    position: '新竹市東區龍山里長參選人',
    region: '新竹市',
    subRegion: '東區龍山里',
    avatarUrl: 'https://ui-avatars.com/api/?name=Li&background=f59e0b&color=fff',
    electionIds: ['election-2026'],
    slogan: '路平燈亮水溝通，服務最貼心',
    bio: '在地服務 20 年，最了解里民需求，隨叫隨到。',
  }
];

export const POLICIES: Policy[] = [
  {
    id: 'p0',
    candidateId: 'c0', 
    title: '和發產業園區初期規劃',
    description: '規劃南部產業用地，為製造業回流做準備。這是 S 廊帶政策的前身。',
    category: 'Economy',
    status: PolicyStatus.ACHIEVED,
    proposedDate: '2019-05-01',
    lastUpdated: '2020-06-01',
    progress: 100,
    tags: ['產業', '園區'],
    logs: [
      { id: 'l0-1', date: '2019-05-01', event: '提出規劃' },
      { id: 'l0-2', date: '2020-01-15', event: '土地徵收完成' },
    ],
    relatedPolicyIds: ['p5']
  },
  {
    id: 'p5',
    candidateId: 'c3',
    title: '半導體 S 廊帶 (延續執行)',
    description: '串聯南科、路竹、橋頭至楠梓，打造全球最完整的半導體產業聚落。本案承接並擴大了早期園區規劃。',
    category: 'Economy',
    status: PolicyStatus.IN_PROGRESS,
    proposedDate: '2020-08-15',
    lastUpdated: '2024-06-15',
    progress: 80,
    tags: ['產業', '台積電'],
    aiAnalysis: 'AI 分析：台積電高雄廠進度順利，本案延續前任市府產業園區基礎，並成功招商台積電。',
    relatedPolicyIds: ['p0'],
    logs: [
      { id: 'l5-1', date: '2021-08-01', event: '台積電宣布設廠' },
      { id: 'l5-2', date: '2024-01-18', event: '2奈米廠動土' },
    ]
  },
  {
    id: 'p1',
    candidateId: 'c1',
    title: '台北大建設 - 都更加速',
    description: '推動公辦都更降門檻，加速台北市老舊公寓改建速度。',
    category: 'Urban Planning',
    status: PolicyStatus.IN_PROGRESS,
    proposedDate: '2022-11-01',
    lastUpdated: '2024-05-15',
    progress: 45,
    tags: ['都更', '居住正義'],
    logs: [
      { id: 'l1-1', date: '2022-11-01', event: '政見提出' },
    ]
  },
  {
    id: 'p4',
    candidateId: 'c2',
    title: '新北捷運三環六線',
    description: '持續推動捷運建設，包含萬大線、三鶯線等。這是跨越十餘年的長期建設案。',
    category: 'Traffic',
    status: PolicyStatus.IN_PROGRESS,
    proposedDate: '2018-06-01',
    lastUpdated: '2024-06-01',
    progress: 75,
    tags: ['交通', '捷運'],
    logs: [
      { id: 'l4-1', date: '2023-01-15', event: '安坑輕軌通車' },
    ]
  }
];

export const CATEGORIES = ['Urban Planning', 'Welfare', 'Traffic', 'Economy', 'Education', 'Environment'];
export const LOCATIONS = ['台北市', '新北市', '高雄市', '新竹市', '台中市', '台南市'];