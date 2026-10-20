import Demo from './workspace';
import './demo.css';
export const metadata={title:'Mirai · Offline viva demonstration',description:'A synthetic, local faculty-to-review workflow. No live AI or audio.'};
export const dynamic='force-dynamic';
export default function Page() {return <Demo enabled={process.env.MIRAI_OFFLINE_DEMO==='1'} />;}
