import { useEffect } from 'react';

/** Keep the document title in sync with the active page. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
