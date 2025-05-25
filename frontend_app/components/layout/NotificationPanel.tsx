// frontend_app/components/layout/NotificationPanel.tsx
"use client";

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useNotificationManager, NotificationLogItem } from '@/components/providers/NotificationProvider';
import { AlertTriangle, CheckCircle2, Info, MessageSquareText, Trash2, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import Link from 'next/link';

const getIconForType = (type: NotificationLogItem['type']) => {
  switch (type) {
    case 'success':
      return <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />;
    case 'error':
      return <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />;
    case 'warning':
      return <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0" />;
    case 'info':
    default:
      return <Info className="h-5 w-5 text-blue-500 flex-shrink-0" />;
  }
};

export default function NotificationPanel() {
  const {
    isPanelOpen,
    closeNotificationPanel,
    notificationsLog,
    clearNotificationsLog,
  } = useNotificationManager();

  return (
    <Dialog open={isPanelOpen} onOpenChange={(open) => { if (!open) closeNotificationPanel(); }}>
      <DialogContent className="sm:max-w-lg md:max-w-xl h-[70vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-4 border-b flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="h-5 w-5" />
            Notifications Log
          </DialogTitle>
          <DialogDescription>
            Recent application and job status updates.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-grow bg-background text-foreground">
          <div className="p-4 space-y-3">
            {notificationsLog.length === 0 ? (
              <p className="text-center text-muted-foreground py-10 italic">
                No notifications yet.
              </p>
            ) : (
              notificationsLog.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "p-3 rounded-md border flex items-start gap-3 text-sm",
                    item.type === 'success' && "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400",
                    item.type === 'error' && "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400",
                    item.type === 'warning' && "bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-400",
                    item.type === 'info' && "bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-400"
                  )}
                >
                  {getIconForType(item.type)}
                  <div className="flex-grow">
                    <p className="font-medium leading-tight">{item.message}</p>
                    {item.description && (
                      <p className="text-xs opacity-80 mt-0.5">{item.description}</p>
                    )}
                    <div className="flex justify-between items-center mt-1.5">
                      <p className="text-xs opacity-70">
                        {formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })}
                      </p>
                      {item.job_id && (
                        <Button variant="link" size="xs" className="p-0 h-auto text-xs opacity-90 hover:opacity-100" asChild>
                           <Link href={`/jobs?highlight=${item.job_id}`}>View Job</Link>
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="p-3 border-t flex-shrink-0 flex-row justify-between items-center">
          <Button
            variant="outline"
            size="sm"
            onClick={clearNotificationsLog}
            disabled={notificationsLog.length === 0}
            className="cursor-pointer"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Clear Log
          </Button>
          <DialogClose asChild>
            <Button type="button" variant="default" size="sm" className="cursor-pointer">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
