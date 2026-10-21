from src.calc import mul


def test_multiplies():
    assert mul(2, 3) == 6


def test_multiplies_by_zero():
    assert mul(5, 0) == 0
