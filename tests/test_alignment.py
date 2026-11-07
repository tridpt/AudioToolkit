import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from worker import build_lines, speaker_at


class AlignmentTests(unittest.TestCase):
    def test_overlap_and_silence_assign_dominant_or_nearest_speaker(self):
        turns = [{'start': 0, 'end': 2, 'speaker': 's1'}, {'start': 3, 'end': 6, 'speaker': 's2'}]
        self.assertEqual(speaker_at(1, 1.5, turns), 's1')
        self.assertEqual(speaker_at(1.8, 4, turns), 's2')
        self.assertEqual(speaker_at(2.7, 2.9, turns), 's2')

    def test_speaker_changes_split_text_without_losing_unicode(self):
        words = [{'text': ' Xin', 'start': 0, 'end': .4, 'probability': .9},
                 {'text': ' chào.', 'start': .4, 'end': 1.5, 'probability': .8},
                 {'text': ' Cảm', 'start': 2, 'end': 2.5, 'probability': .95},
                 {'text': ' ơn!', 'start': 2.5, 'end': 3, 'probability': .95}]
        turns = [{'start': 0, 'end': 1.5, 'speaker': 's1'}, {'start': 2, 'end': 3, 'speaker': 's2'}]
        lines = build_lines(words, turns, 3)
        self.assertEqual([line['text'] for line in lines], ['Xin chào.', 'Cảm ơn!'])
        self.assertEqual([line['speaker'] for line in lines], ['s1', 's2'])
        self.assertEqual(lines[0]['confidence'], 85)

    def test_pause_and_audio_boundaries(self):
        words = [{'text': ' one', 'start': 0, 'end': .3}, {'text': ' two', 'start': 2, 'end': 6}, {'text': ' invalid', 'start': 8, 'end': 7}]
        lines = build_lines(words, [], 4)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1]['end'], 4)
        self.assertIsNone(lines[0]['confidence'])


if __name__ == '__main__':
    unittest.main()
