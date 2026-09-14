/** Human statements remain the source of truth; topics are a derived view. */
export interface MeetingTopic {
  id: string;
  title: string;
  summary: string;
  decisions: string[];
  openQuestions: string[];
  sourceIds: string[];
  updatedAt: number;
}

export interface MeetingKnowledge {
  revision: number;
  updatedAt: number;
  topics: MeetingTopic[];
}

export interface MinutesUpdate {
  meetingId: string;
  topics: Array<Omit<MeetingTopic, "id" | "updatedAt"> & { id: string | null }>;
}

export interface KnowledgeQuery {
  query?: string;
  meetingId?: string;
  sourceIds?: string[];
  offset?: number;
  limit?: number;
}

export interface KnowledgePage {
  projectId: string;
  documents?: Array<{
    meetingId: string;
    name: string;
    revision: number;
    updatedAt: number;
    markdown: string;
    truncated?: boolean;
  }>;
  topics: Array<
    MeetingTopic & {
      meetingId: string;
      meetingName: string;
      truncated?: boolean;
      sourceCount?: number;
    }
  >;
  messages: Array<{
    id: string;
    meetingId: string;
    authorId: string;
    authorName: string;
    at: number;
    text: string;
    complete: boolean;
    truncated?: boolean;
  }>;
  total: number;
  offset: number;
  nextOffset?: number;
}
