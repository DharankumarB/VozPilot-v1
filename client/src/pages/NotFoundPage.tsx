import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { LogoMark } from '../components/brand/Logo';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Page not found · VozPilot');
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <LogoMark size={46} />
      <div>
        <p className="font-mono text-xs font-bold uppercase tracking-[0.3em] text-gild-400">Error 404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-mist-100">This sector is empty</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-mist-500">
          The page you requested doesn't exist in VozPilot. Head back to your overview and take it from there.
        </p>
      </div>
      <Link to="/" className="focus-ring rounded-xl">
        <Button variant="primary" icon={<Compass size={15} />}>
          Back to Overview
        </Button>
      </Link>
    </div>
  );
}
