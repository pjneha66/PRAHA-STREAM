import React, { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { isAndroidApp, openArchiveLoan, openSafeExternalUrl } from '../services/androidBridge';
import { BooksService } from '../services/archiveService';

export default function ArchiveBorrowButton({ identifier }: { identifier: string }) {
  const [failed, setFailed] = useState(false);
  const url = BooksService.detailsUrl(identifier);
  return (
    <>
      <button type="button" className="button button-primary" onClick={async () => setFailed(!await openArchiveLoan(url))}>
        <BookOpen size={14} /> {isAndroidApp() ? 'Borrow free in PRAHA' : 'Borrow free on Internet Archive'}
      </button>
      {failed && (
        <button type="button" className="button button-secondary" onClick={() => void openSafeExternalUrl(url)}>
          Open Internet Archive in your browser
        </button>
      )}
    </>
  );
}
