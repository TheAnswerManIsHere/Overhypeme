import { useQueryClient } from "@tanstack/react-query";
import {
  useRateFact,
  useAddComment,
  useDeleteLink,
  useRecordSearch,
  getListFactsQueryKey,
  getGetFactQueryKey,
  getListCommentsQueryKey,
  getListLinksQueryKey,
  getGetMyProfileQueryKey
} from "@workspace/api-client-react";

export function useAppMutations() {
  const queryClient = useQueryClient();

  const rateFactMutation = useRateFact({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: getListFactsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetFactQueryKey(variables.factId) });
        queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
      }
    }
  });

  const addCommentMutation = useAddComment({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: getListCommentsQueryKey(variables.factId) });
        queryClient.invalidateQueries({ queryKey: getGetFactQueryKey(variables.factId) });
      }
    }
  });

  const deleteLinkMutation = useDeleteLink({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: getListLinksQueryKey(variables.factId) });
        queryClient.invalidateQueries({ queryKey: getGetFactQueryKey(variables.factId) });
      }
    }
  });

  const recordSearchMutation = useRecordSearch({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
      }
    }
  });

  return {
    rateFact: rateFactMutation,
    addComment: addCommentMutation,
    deleteLink: deleteLinkMutation,
    recordSearch: recordSearchMutation
  };
}
